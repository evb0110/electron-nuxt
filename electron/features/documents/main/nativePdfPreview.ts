import {
    mkdtemp,
    readFile,
    rm,
} from 'fs/promises';
import {join} from 'path';
import { tmpdir } from 'os';
import type {
    IPdfNativePagePreview,
    IPdfNativePagePreviewOptions,
    IPdfNativePageSize,
} from '@contracts/electronApiDocuments';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';
import { resolveExistingReadablePdfPath } from '@electron/features/documents/main/documentFilePathResolution';
import { buildPopplerEnv } from '@electron/native-tools/buildPopplerEnv';
import {
    runNativeToolCommand,
    type IRunNativeToolCommandOptions,
} from '@electron/native-tools/runNativeToolCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { cancelNativeCommandGroup } from '@electron/native-tools/runNativeCommand';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';

const PDFINFO_TIMEOUT_MS = 20_000;
const PDF_RENDER_TIMEOUT_MS = 30_000;
const PDFINFO_DETAILED_PAGE_LIMIT = 5_000;
const PDFINFO_BASE_STDOUT_BYTES = 256 * 1024;
const PDFINFO_PER_PAGE_STDOUT_BYTES = 512;
const PDF_RENDER_DEFAULT_TARGET_WIDTH_PX = 1_200;
const PDF_RENDER_MIN_TARGET_WIDTH_PX = 64;
const PDF_RENDER_MAX_TARGET_WIDTH_PX = 4_096;

const PAGE_COUNT_RE = /^Pages:\s+(\d+)\s*$/imu;
const DEFAULT_PAGE_SIZE_RE = /^Page size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts\b/imu;
const PAGE_SIZE_RE = /^Page\s+(\d+)\s+size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts\b/gimu;

const activePreviewAborters = new Map<string, (reason: string) => void>();

function parsePositiveFiniteNumber(value: string | undefined) {
    const parsed = Number.parseFloat(value ?? '');
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function withPopplerEnv(
    env: NodeJS.ProcessEnv | undefined,
    options: IRunNativeToolCommandOptions,
): IRunNativeToolCommandOptions {
    return env ? {
        ...options,
        env, 
    } : options;
}

function normalizePageCount(pdfInfoOutput: string) {
    const count = Number.parseInt(PAGE_COUNT_RE.exec(pdfInfoOutput)?.[1] ?? '', 10);
    if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error('Unable to determine PDF page count for native preview');
    }
    return count;
}

function parseDefaultPageSize(pdfInfoOutput: string): IPdfNativePageSize | null {
    const match = DEFAULT_PAGE_SIZE_RE.exec(pdfInfoOutput);
    const width = parsePositiveFiniteNumber(match?.[1]);
    const height = parsePositiveFiniteNumber(match?.[2]);
    return width && height ? {
        width,
        height, 
    } : null;
}

export function parsePdfInfoPageSizes(
    pdfInfoOutput: string,
    pageCount: number,
    fallbackPageSize?: IPdfNativePageSize | null,
): IPdfNativePageSize[] {
    const sizes = Array.from({ length: pageCount }, () => (
        fallbackPageSize
            ? { ...fallbackPageSize }
            : null
    ));

    PAGE_SIZE_RE.lastIndex = 0;
    for (const match of pdfInfoOutput.matchAll(PAGE_SIZE_RE)) {
        const pageNumber = Number.parseInt(match[1] ?? '', 10);
        const width = parsePositiveFiniteNumber(match[2]);
        const height = parsePositiveFiniteNumber(match[3]);
        if (
            !Number.isSafeInteger(pageNumber)
            || pageNumber < 1
            || pageNumber > pageCount
            || !width
            || !height
        ) {
            continue;
        }
        sizes[pageNumber - 1] = {
            width,
            height, 
        };
    }

    const firstResolvedSize = sizes.find((size): size is IPdfNativePageSize => Boolean(size));
    if (!firstResolvedSize) {
        throw new Error('Unable to determine PDF page dimensions for native preview');
    }

    return sizes.map(size => size ?? { ...firstResolvedSize });
}

function normalizePreviewTargetWidth(options: IPdfNativePagePreviewOptions | undefined) {
    const rawTargetWidth = options?.targetWidthPx ?? PDF_RENDER_DEFAULT_TARGET_WIDTH_PX;
    if (!Number.isFinite(rawTargetWidth)) {
        return PDF_RENDER_DEFAULT_TARGET_WIDTH_PX;
    }
    return Math.min(
        PDF_RENDER_MAX_TARGET_WIDTH_PX,
        Math.max(PDF_RENDER_MIN_TARGET_WIDTH_PX, Math.trunc(rawTargetWidth)),
    );
}

function normalizePreviewRequestId(options: IPdfNativePagePreviewOptions | undefined) {
    const requestId = options?.previewRequestId?.trim();
    return requestId && requestId.length > 0 ? requestId : null;
}

function getPreviewAborterKey(senderId: number, requestId: string) {
    return `${senderId}:${requestId}`;
}

function getPreviewRequestOwnerId(context: IDocumentsSenderIdContext) {
    return context.senderId ?? -1;
}

function readPngDimensions(bytes: Uint8Array) {
    if (
        bytes.byteLength < 24
        || bytes[0] !== 0x89
        || bytes[1] !== 0x50
        || bytes[2] !== 0x4e
        || bytes[3] !== 0x47
        || bytes[12] !== 0x49
        || bytes[13] !== 0x48
        || bytes[14] !== 0x44
        || bytes[15] !== 0x52
    ) {
        throw new Error('Native PDF preview renderer produced an invalid PNG');
    }

    return {
        width: bytes.buffer instanceof ArrayBuffer
            ? new DataView(bytes.buffer, bytes.byteOffset + 16, 8).getUint32(0)
            : Buffer.from(bytes).readUInt32BE(16),
        height: bytes.buffer instanceof ArrayBuffer
            ? new DataView(bytes.buffer, bytes.byteOffset + 16, 8).getUint32(4)
            : Buffer.from(bytes).readUInt32BE(20),
    };
}

async function resolvePdfPath(context: IDocumentsSenderIdContext, filePath: unknown) {
    return resolveExistingReadablePdfPath(filePath, context.senderId);
}

function abortPreviewController(controller: AbortController, reason: string) {
    if (!controller.signal.aborted) {
        controller.abort(new Error(reason));
    }
}

function cancelActivePreviewRequest(senderId: number, requestId: string, reason: string) {
    const abort = activePreviewAborters.get(getPreviewAborterKey(senderId, requestId));
    if (!abort) {
        return false;
    }
    abort(reason);
    return true;
}

function registerPreviewSenderCleanup(sender: Electron.WebContents | undefined, abort: (reason: string) => void) {
    if (!sender) {
        return () => undefined;
    }
    if (sender.isDestroyed()) {
        abort('Renderer lifecycle ended');
        return () => undefined;
    }

    const handleDestroyed = () => abort('Renderer lifecycle ended');
    const handleRenderProcessGone = () => abort('Renderer lifecycle ended');
    const handleNavigation = (
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (isMainFrame && !isInPlace) {
            abort('Renderer navigation canceled native PDF preview');
        }
    };

    sender.once('destroyed', handleDestroyed);
    sender.once('render-process-gone', handleRenderProcessGone);
    sender.on('did-start-navigation', handleNavigation);

    return () => {
        sender.removeListener('destroyed', handleDestroyed);
        sender.removeListener('render-process-gone', handleRenderProcessGone);
        sender.removeListener('did-start-navigation', handleNavigation);
    };
}

export async function handlePdfNativePageSizes(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
): Promise<IPdfNativePageSize[]> {
    const resolvedPath = await resolvePdfPath(context, filePath);
    const tools = getPdfNativeToolPaths();
    const env = buildPopplerEnv(tools);
    const overview = await runNativeToolCommand(
        tools.pdfinfo,
        [resolvedPath],
        withPopplerEnv(env, {
            timeoutMs: PDFINFO_TIMEOUT_MS,
            maxStdoutBytes: PDFINFO_BASE_STDOUT_BYTES,
            commandLabel: 'pdfinfo',
        }),
    );
    const pageCount = normalizePageCount(overview.stdout);
    const fallbackPageSize = parseDefaultPageSize(overview.stdout);

    if (pageCount > PDFINFO_DETAILED_PAGE_LIMIT) {
        return parsePdfInfoPageSizes(overview.stdout, pageCount, fallbackPageSize);
    }

    const detailed = await runNativeToolCommand(
        tools.pdfinfo,
        [
            '-box',
            '-f',
            '1',
            '-l',
            String(pageCount),
            resolvedPath,
        ],
        withPopplerEnv(env, {
            timeoutMs: PDFINFO_TIMEOUT_MS,
            maxStdoutBytes: Math.max(PDFINFO_BASE_STDOUT_BYTES, pageCount * PDFINFO_PER_PAGE_STDOUT_BYTES),
            rejectOnStdoutTruncation: true,
            commandLabel: 'pdfinfo',
        }),
    );

    return parsePdfInfoPageSizes(
        detailed.stdout,
        pageCount,
        parseDefaultPageSize(detailed.stdout) ?? fallbackPageSize,
    );
}

export function handleCancelPdfNativePagePreview(
    context: IDocumentsSenderIdContext,
    requestId: string,
): Promise<{ canceled: boolean }> {
    const canceled = cancelActivePreviewRequest(
        getPreviewRequestOwnerId(context),
        requestId,
        'Native PDF preview canceled',
    );
    return Promise.resolve({canceled});
}

export async function handlePdfNativePagePreview(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    pageNumber: unknown,
    options?: IPdfNativePagePreviewOptions,
): Promise<IPdfNativePagePreview> {
    const resolvedPath = await resolvePdfPath(context, filePath);
    const page = Number(pageNumber);
    if (!Number.isSafeInteger(page) || page < 1) {
        throw new Error(`Invalid PDF page number: ${String(pageNumber)}`);
    }

    const targetWidthPx = normalizePreviewTargetWidth(options);
    const previewRequestId = normalizePreviewRequestId(options);
    const ownerId = getPreviewRequestOwnerId(context);
    const tools = getPdfNativeToolPaths();
    const env = buildPopplerEnv(tools);
    const abortController = new AbortController();
    let cancelGroup = '';
    const cancelPreview = (reason: string) => {
        abortPreviewController(abortController, reason);
        if (cancelGroup) {
            cancelNativeCommandGroup(cancelGroup);
        }
    };
    if (previewRequestId) {
        activePreviewAborters.set(
            getPreviewAborterKey(ownerId, previewRequestId),
            cancelPreview,
        );
    }
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath: resolvedPath,
        cancel: (reason) => {
            cancelPreview(reason);
        },
    });
    cancelGroup = `pdf-native-preview:${mainOperation.id}`;
    const handleMainAbort = () => {
        cancelPreview('Native PDF preview canceled');
    };
    const unregisterSenderCleanup = registerPreviewSenderCleanup(context.sender, (reason) => {
        cancelPreview(reason);
    });
    mainOperation.signal.addEventListener('abort', handleMainAbort, { once: true });
    let tempDir: string | null = null;

    try {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-pdf-native-preview-'));
        const outputPrefix = join(tempDir, 'page');
        const outputPath = `${outputPrefix}.png`;
        await runNativeToolCommand(
            tools.pdftoppm,
            [
                '-png',
                '-singlefile',
                '-scale-to-x',
                String(targetWidthPx),
                '-scale-to-y',
                '-1',
                '-f',
                String(page),
                '-l',
                String(page),
                resolvedPath,
                outputPrefix,
            ],
            withPopplerEnv(env, {
                timeoutMs: PDF_RENDER_TIMEOUT_MS,
                maxStdoutBytes: 64 * 1024,
                maxStderrBytes: 512 * 1024,
                commandLabel: 'pdftoppm',
                signal: abortController.signal,
                cancelGroup,
            }),
        );
        const bytes = new Uint8Array(await readFile(outputPath));
        const {
            width,
            height,
        } = readPngDimensions(bytes);
        return {
            bytes,
            width,
            height,
        };
    } finally {
        if (previewRequestId) {
            activePreviewAborters.delete(getPreviewAborterKey(ownerId, previewRequestId));
        }
        if (tempDir !== null) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        }
        mainOperation.signal.removeEventListener('abort', handleMainAbort);
        unregisterSenderCleanup();
        mainOperation.complete();
    }
}
