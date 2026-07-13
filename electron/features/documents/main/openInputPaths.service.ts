import { existsSync } from 'fs';
import {
    mkdtemp,
    rm,
} from 'fs/promises';
import { tmpdir } from 'os';
import {
    basename,
    join,
} from 'path';
import {
    buildCombinedPdfOutputPath,
    createPdfFileFromInputPaths,
    type ICreatePdfFromInputPathsProgress,
    isDjvuPath,
    isPdfPath,
    isSupportedOpenPath,
} from '@electron/image/pdfConversion';
import {
    createWorkingCopy,
    createWorkingCopyFromPath,
} from '@electron/file-access/workingCopyCreation';
import {
    allowOpenPaths,
    requireOpenPath,
} from '@electron/file-access/openPathCapabilities';
import { te } from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';
import { addRecentInputs } from '@electron/features/documents/main/addRecentInputs.service';
import {getErrorMessage} from '@electron/utils/error';
import { normalizePossiblyEncodedExistingPath } from '@electron/utils/normalizePossiblyEncodedExistingPath';
import type { TOpenFileResult } from '@electron/features/documents/contract';
import type { TOpenPathOwner } from '@electron/features/documents/main/openPathOwner';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';
import { abortErrorFromSignal } from '@electron/utils/abort';
import { mainJobBroker } from '@electron/resources/jobBroker';

const logger = createLogger('documents-open-service');
const MAX_OPEN_INPUT_PATHS = 512;

interface IOpenInputPathsOptions {
    onCombineProgress?: (progress: ICreatePdfFromInputPathsProgress) => void;
    signal?: AbortSignal;
    forceCombine?: boolean;
}

interface IOpenInputPathsAbortLifecycle {
    signal: AbortSignal;
    cleanup: () => void;
}

export function assertOpenInputPathCount(paths: readonly unknown[]) {
    if (paths.length > MAX_OPEN_INPUT_PATHS) {
        throw new Error(te('errors.file.invalid'));
    }
}

function formatPathListForLog(paths: string[]) {
    const visiblePaths = paths.slice(0, 20);
    const suffix = paths.length > visiblePaths.length
        ? ` | ... (${paths.length - visiblePaths.length} more)`
        : '';
    return `${visiblePaths.join(' | ')}${suffix}`;
}

function getOwnerWebContentsId(owner?: TOpenPathOwner) {
    if (typeof owner === 'number') {
        return owner;
    }
    return owner?.id;
}

function isWebContentsOwner(owner?: TOpenPathOwner): owner is Electron.WebContents {
    return typeof owner === 'object'
        && owner !== null
        && typeof owner.id === 'number'
        && typeof owner.once === 'function'
        && typeof owner.removeListener === 'function';
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function createOpenInputPathsAbortLifecycle(
    owner: TOpenPathOwner | undefined,
    operationPath: string,
    externalSignal?: AbortSignal,
): IOpenInputPathsAbortLifecycle {
    const ownerWebContentsId = getOwnerWebContentsId(owner);
    const abortController = new AbortController();
    const abort = (reason: string | Error) => {
        if (!abortController.signal.aborted) {
            abortController.abort(reason instanceof Error ? reason : new Error(reason));
        }
    };
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId,
        workingCopyPath: operationPath,
        cancel: abort,
    });
    const abortFromMainOperation = () => {
        abort(mainOperation.signal.reason instanceof Error
            ? mainOperation.signal.reason
            : 'Open input paths operation canceled');
    };
    const abortFromExternalSignal = () => {
        abort(externalSignal?.reason instanceof Error
            ? externalSignal.reason
            : 'Open input paths operation canceled');
    };
    mainOperation.signal.addEventListener('abort', abortFromMainOperation, { once: true });
    externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true });
    if (externalSignal?.aborted) {
        abortFromExternalSignal();
    }

    let handleDestroyed: (() => void) | null = null;
    let handleRenderProcessGone: (() => void) | null = null;
    let handleNavigation: ((
        event: Electron.Event,
        url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => void) | null = null;

    if (isWebContentsOwner(owner)) {
        handleDestroyed = () => abort('Renderer lifecycle ended');
        handleRenderProcessGone = () => abort('Renderer lifecycle ended');
        handleNavigation = (
            _event: Electron.Event,
            _url: string,
            isInPlace: boolean,
            isMainFrame: boolean,
        ) => {
            if (isMainFrame && !isInPlace) {
                abort('Renderer navigation canceled open input paths operation');
            }
        };
        owner.once('destroyed', handleDestroyed);
        owner.once('render-process-gone', handleRenderProcessGone);
        owner.on('did-start-navigation', handleNavigation);
    }

    return {
        signal: abortController.signal,
        cleanup: () => {
            mainOperation.signal.removeEventListener('abort', abortFromMainOperation);
            externalSignal?.removeEventListener('abort', abortFromExternalSignal);
            if (isWebContentsOwner(owner)) {
                if (handleDestroyed) {
                    owner.removeListener('destroyed', handleDestroyed);
                }
                if (handleRenderProcessGone) {
                    owner.removeListener('render-process-gone', handleRenderProcessGone);
                }
                if (handleNavigation) {
                    owner.removeListener('did-start-navigation', handleNavigation);
                }
            }
            mainOperation.complete();
        },
    };
}

export async function openInputPaths(
    paths: string[],
    options: IOpenInputPathsOptions = {},
    owner?: TOpenPathOwner,
): Promise<TOpenFileResult | null> {
    const normalizedPaths = paths.filter(path => typeof path === 'string' && path.length > 0)
        .map(path => normalizePossiblyEncodedExistingPath(path) ?? path);
    logger.debug(`openInputPaths normalized ${normalizedPaths.length} path(s): ${formatPathListForLog(normalizedPaths)}`);
    if (normalizedPaths.length === 0) {
        return null;
    }
    assertOpenInputPathCount(normalizedPaths);

    if (normalizedPaths.some(path => !existsSync(path))) {
        throw new Error(te('errors.file.invalid'));
    }

    if (normalizedPaths.some(path => !isSupportedOpenPath(path))) {
        throw new Error(te('errors.file.invalid'));
    }

    allowOpenPaths(normalizedPaths, owner);

    const djvuPaths = normalizedPaths.filter(path => isDjvuPath(path));
    if (!options.forceCombine && djvuPaths.length > 0 && normalizedPaths.length === 1 && djvuPaths.length === 1) {
        const djvuPath = djvuPaths[0]!;
        const trustedDjvuPath = requireOpenPath(djvuPath, owner);
        logger.debug(`openInputPaths resolved DjVu path: ${djvuPath}`);
        persistRecentInputsAfterOpen([djvuPath], owner);
        return {
            kind: 'djvu',
            workingPath: '',
            originalPath: trustedDjvuPath,
        };
    }

    if (!options.forceCombine && normalizedPaths.length === 1 && isPdfPath(normalizedPaths[0]!)) {
        const sourceCriticalStartedAt = performance.now();
        const originalPath = normalizedPaths[0]!;
        logger.debug(`openInputPaths creating working copy for PDF: ${originalPath}`);
        const workingPath = await createWorkingCopy(requireOpenPath(originalPath, owner), getOwnerWebContentsId(owner));
        persistRecentInputsAfterOpen([originalPath], owner);
        logger.debug(`openInputPaths PDF source-critical timings: ${JSON.stringify({
            recentPersistence: 'background',
            totalMs: Math.round((performance.now() - sourceCriticalStartedAt) * 10) / 10,
        })}`);
        return {
            kind: 'pdf',
            workingPath,
            originalPath,
        };
    }

    const outputPath = buildCombinedPdfOutputPath(normalizedPaths);
    const tempDir = await mkdtemp(join(tmpdir(), 'pdf-combine-open-'));
    let lifecycle: IOpenInputPathsAbortLifecycle | null = null;
    let brokerLease: Awaited<ReturnType<typeof mainJobBroker.acquire>> | null = null;
    let workingPath: string;
    try {
        lifecycle = createOpenInputPathsAbortLifecycle(
            owner,
            outputPath,
            options.signal,
        );
        const { signal } = lifecycle;
        brokerLease = await mainJobBroker.acquire({
            ownerId: `pdf-combine:${getOwnerWebContentsId(owner) ?? 'main'}`,
            kind: 'pdf-combine',
            priority: 'user',
            perOwnerLimit: 1,
            signal,
            resources: {
                // Admission lease only. Conversion sub-pipelines acquire the
                // concrete CPU/memory/native resources they need, avoiding a
                // nested-lease deadlock on minimum-capacity hosts.
                cpuTokens: 0,
                estimatedResidentBytes: 0,
                nativeProcesses: 0,
                ioWeight: 0,
            },
        });
        const tempOutputPath = join(tempDir, basename(outputPath));
        throwIfAborted(signal);
        await createPdfFileFromInputPaths(
            normalizedPaths,
            tempOutputPath,
            {
                ...(options.onCombineProgress ? { onProgress: options.onCombineProgress } : {}),
                signal,
            },
        );
        throwIfAborted(signal);
        logger.info(`openInputPaths created combined PDF for batch; output: ${outputPath}`);
        allowOpenPaths([tempOutputPath], owner);
        const trustedTempOutputPath = requireOpenPath(tempOutputPath, owner);
        workingPath = await createWorkingCopyFromPath(
            trustedTempOutputPath,
            outputPath,
            getOwnerWebContentsId(owner),
        );
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
        brokerLease?.release();
        lifecycle?.cleanup();
    }

    return {
        kind: 'pdf',
        workingPath,
        originalPath: outputPath,
        isGenerated: true,
    };
}

function persistRecentInputsAfterOpen(paths: string[], owner?: TOpenPathOwner) {
    void addRecentInputs(paths, owner).catch(error => {
        logger.warn(`Failed to persist opened input in Recent Files: ${getErrorMessage(error)}`);
    });
}
