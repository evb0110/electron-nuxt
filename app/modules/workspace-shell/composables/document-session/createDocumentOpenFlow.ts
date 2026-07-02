import { clamp } from 'es-toolkit/math';
import type { useAnalytics } from '@app/composables/useAnalytics';
import type { TTranslateFn } from '@i18n-app';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { TPdfSource } from '@app/types/pdf';
import type { IDocumentSessionState } from '@app/modules/workspace-shell/composables/document-session/createDocumentSessionState';
import type { IPdfLoadedState } from '@app/modules/workspace-shell/composables/document-session/createDocumentHistory';
import type { IPdfConformanceDeferralOptions } from '@app/modules/workspace-shell/composables/document-session/createDocumentConformance';
import type { createEpochGuard } from '@app/modules/workspace-shell/composables/document-session/createEpochGuard';
import { BrowserLogger } from '@app/utils/browserLogger';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import {
    bucketFileSize,
    getLowercaseExtension,
} from '@app/utils/analytics';
import { readDocumentBytes } from '@app/utils/documentBytes';
import { getDocumentRefBaseName } from '@app/utils/documentRef';
import { getErrorMessage } from '@app/utils/error';
import {
    getDocumentFilesCapability,
    getDocumentMenuCapability,
    getDocumentOpenCapability,
    getDocumentPickerCapability,
} from '@app/utils/platformDocuments';

type TAnalytics = ReturnType<typeof useAnalytics>;
type TEpochGuard = ReturnType<typeof createEpochGuard>;

interface ICreateDocumentOpenFlowDeps {
    analytics: TAnalytics;
    cleanupAbandonedWorkingCopy: (path: TDocumentRef) => Promise<void>;
    clearPdfConformanceProfile: () => void;
    cleanupPreviousWorkingCopy: (path: TDocumentRef, nextPath: TDocumentRef) => Promise<void>;
    deferPdfConformanceProfile: (
        path: TDocumentRef,
        options?: IPdfConformanceDeferralOptions,
    ) => void;
    incrementSessionVersion: () => void;
    loadEpoch: TEpochGuard;
    openEpoch: TEpochGuard;
    pushHistorySnapshot: (
        snapshot: Uint8Array,
        options?: { reuseSnapshot?: boolean },
    ) => Promise<boolean>;
    resetHistory: (
        snapshot: Uint8Array | null,
        options?: {
            reuseSnapshot?: boolean;
            isCurrent?: (() => boolean) | undefined;
        },
    ) => Promise<boolean>;
    syncDirtyFromHistory: () => void;
    t: TTranslateFn;
}

const RECENT_OPEN_LOG_SECTION = 'recent-open';
const MAX_IN_MEMORY_PDF_BYTES = 64 * 1024 * 1024;

export function createDocumentOpenFlow(
    state: IDocumentSessionState,
    deps: ICreateDocumentOpenFlowDeps,
) {
    function assertPdfHasBytes(size: number) {
        if (size > 0) {
            return;
        }

        throw new Error(deps.t('errors.file.emptyPdf'));
    }

    function toPdfBlob(snapshot: Uint8Array) {
        const ownedSnapshot = (
            snapshot.buffer instanceof ArrayBuffer
            && snapshot.byteOffset === 0
            && snapshot.byteLength === snapshot.buffer.byteLength
        )
            ? snapshot as Uint8Array<ArrayBuffer>
            : (
                snapshot.byteOffset === 0
                && snapshot.byteLength === snapshot.buffer.byteLength
            )
                ? new Uint8Array(snapshot)
                : snapshot.slice();
        return new Blob([ownedSnapshot], { type: 'application/pdf' });
    }

    function getLoadedPdfFileSize(nextState: IPdfLoadedState) {
        if (nextState.pdfData) {
            return nextState.pdfData.byteLength;
        }
        const source = nextState.pdfSrc;
        if (
            source
            && typeof source === 'object'
            && 'kind' in source
            && source.kind === 'path'
        ) {
            return source.size;
        }
        return null;
    }

    async function pickFileToOpen() {
        return getDocumentPickerCapability().openDocumentDialog();
    }

    async function trackOpenedDocument(
        result: TOpenFileResult,
        openMethod: 'picker' | 'preselected' | 'direct' | 'batch',
    ) {
        const fileName = getDocumentRefBaseName(result.originalPath);
        let fileSizeBucket: string | null = null;

        try {
            const { size } = await getDocumentFilesCapability().statFile(result.originalPath);
            fileSizeBucket = bucketFileSize(size);
        } catch {
            fileSizeBucket = null;
        }

        deps.analytics.setDocumentContext({
            documentKind: result.kind,
            fileExtension: getLowercaseExtension(fileName),
            fileSizeBucket,
            isGenerated: result.kind === 'pdf' ? Boolean(result.isGenerated) : false,
            pageCountBucket: null,
            totalPages: null,
        });
        deps.analytics.track('document_opened', {
            documentKind: result.kind,
            fileExtension: getLowercaseExtension(fileName),
            fileSizeBucket,
            isGenerated: result.kind === 'pdf' ? Boolean(result.isGenerated) : false,
            openMethod,
            requiresSaveAsOnFirstSave: result.kind === 'pdf' ? Boolean(result.isGenerated) : false,
        });
    }

    function beginOpenRequest() {
        deps.loadEpoch.invalidate();
        return deps.openEpoch.begin();
    }

    function isCurrentOpenRequest(requestId: number) {
        return deps.openEpoch.isCurrent(requestId);
    }

    function isCurrentLoadRequest(requestId: number) {
        return deps.loadEpoch.isCurrent(requestId);
    }

    function isCurrentOpenLoadRequest(openRequestId: number, loadRequestId: number) {
        return isCurrentOpenRequest(openRequestId) && isCurrentLoadRequest(loadRequestId);
    }

    async function cleanupAbandonedPdfWorkingCopy(
        result: TOpenFileResult,
        reason: string,
    ) {
        if (result.kind !== 'pdf' || state.isActiveWorkingCopy(result.workingPath)) {
            return;
        }

        try {
            await deps.cleanupAbandonedWorkingCopy(result.workingPath);
        } catch (cleanupError) {
            BrowserLogger.warn(
                RECENT_OPEN_LOG_SECTION,
                'Failed to cleanup abandoned PDF working copy',
                {
                    path: result.workingPath,
                    reason,
                    error: cleanupError,
                },
            );
        }
    }

    async function openFile(preSelected?: TOpenFileResult) {
        const openRequestId = beginOpenRequest();
        state.error.value = null;
        state.pendingDjvu.value = null;
        state.openBatchProgress.value = null;
        try {
            const result = preSelected ?? (await pickFileToOpen());
            if (!isCurrentOpenRequest(openRequestId)) {
                if (result) {
                    await cleanupAbandonedPdfWorkingCopy(result, 'stale-picker-result');
                    return {
                        status: 'stale',
                        result,
                    } satisfies TDocumentOpenOutcome;
                }
                return { status: 'cancelled' } satisfies TDocumentOpenOutcome;
            }
            if (!result) {
                return { status: 'cancelled' } satisfies TDocumentOpenOutcome;
            }
            if (result.kind === 'djvu') {
                state.pendingDjvu.value = result.originalPath;
                await trackOpenedDocument(result, preSelected ? 'preselected' : 'picker');
                return {
                    status: 'opened',
                    result,
                } satisfies TDocumentOpenOutcome;
            }
            return await finishPdfOpenResult(
                openRequestId,
                result,
                preSelected ? 'preselected' : 'picker',
            );
        } catch (e) {
            if (!isCurrentOpenRequest(openRequestId)) {
                return {
                    status: 'failed',
                    error: classifyOpenError(e, preSelected?.originalPath ?? null),
                } satisfies TDocumentOpenOutcome;
            }
            const message = classifyOpenError(e, preSelected?.originalPath ?? null);
            state.error.value = message;
            return {
                status: 'failed',
                error: message,
            } satisfies TDocumentOpenOutcome;
        }
    }

    async function finishPdfOpenResult(
        openRequestId: number,
        result: Extract<TOpenFileResult, { kind: 'pdf' }>,
        openMethod: 'picker' | 'preselected' | 'direct' | 'batch',
    ) {
        try {
            await loadPdfFromPath(result.workingPath, {
                markDirty: !!result.isGenerated,
                openRequestId,
                resetSourceBeforeCommit: true,
            });
        } catch (error) {
            await cleanupAbandonedPdfWorkingCopy(result, 'failed-pdf-load');
            throw error;
        }
        if (!isCurrentOpenRequest(openRequestId) || state.workingCopyPath.value !== result.workingPath) {
            await cleanupAbandonedPdfWorkingCopy(result, 'stale-pdf-load');
            return {
                status: 'stale',
                result,
            } satisfies TDocumentOpenOutcome;
        }
        await trackOpenedDocument(result, openMethod);
        if (!isCurrentOpenRequest(openRequestId) || state.workingCopyPath.value !== result.workingPath) {
            await cleanupAbandonedPdfWorkingCopy(result, 'stale-pdf-track');
            return {
                status: 'stale',
                result,
            } satisfies TDocumentOpenOutcome;
        }
        state.originalPath.value = result.originalPath;
        state.requiresSaveAsOnFirstSave.value = !!result.isGenerated;
        return {
            status: 'opened',
            result,
        } satisfies TDocumentOpenOutcome;
    }

    async function openFileDirect(path: TDocumentRef) {
        const openRequestId = beginOpenRequest();
        state.error.value = null;
        state.pendingDjvu.value = null;
        state.openBatchProgress.value = null;
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'openFileDirect started', {path});
        try {
            const result = await getDocumentOpenCapability().openDocumentDirect(path);
            if (!isCurrentOpenRequest(openRequestId)) {
                if (result) {
                    await cleanupAbandonedPdfWorkingCopy(result, 'stale-direct-result');
                    return {
                        status: 'stale',
                        result,
                    } satisfies TDocumentOpenOutcome;
                }
                return {
                    status: 'failed',
                    error: deps.t('errors.file.invalid'),
                } satisfies TDocumentOpenOutcome;
            }
            if (!result) {
                const message = deps.t('errors.file.invalid');
                state.error.value = message;
                BrowserLogger.warn(
                    RECENT_OPEN_LOG_SECTION,
                    'openDocumentDirect returned null',
                    { path },
                );
                return {
                    status: 'failed',
                    error: message,
                } satisfies TDocumentOpenOutcome;
            }

            BrowserLogger.debug(
                RECENT_OPEN_LOG_SECTION,
                'openDocumentDirect returned result',
                {
                    path,
                    kind: result.kind,
                    isGenerated:
                        result.kind === 'pdf' ? Boolean(result.isGenerated) : undefined,
                    workingPath: result.kind === 'pdf' ? result.workingPath : undefined,
                },
            );

            if (result.kind === 'djvu') {
                state.pendingDjvu.value = result.originalPath;
                await trackOpenedDocument(result, 'direct');
                BrowserLogger.debug(
                    RECENT_OPEN_LOG_SECTION,
                    'openFileDirect entered DjVu mode',
                    {
                        path,
                        djvuPath: result.originalPath,
                    },
                );
                return {
                    status: 'opened',
                    result,
                } satisfies TDocumentOpenOutcome;
            }
            BrowserLogger.debug(
                RECENT_OPEN_LOG_SECTION,
                'Loading PDF from working path',
                {
                    path,
                    workingPath: result.workingPath,
                },
            );
            const outcome = await finishPdfOpenResult(openRequestId, result, 'direct');
            if (outcome.status === 'stale') {
                BrowserLogger.debug(
                    RECENT_OPEN_LOG_SECTION,
                    'openFileDirect skipped stale load result',
                    {
                        path,
                        workingPath: result.workingPath,
                    },
                );
                return outcome;
            }
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'openFileDirect completed', {
                path,
                workingPath: result.workingPath,
                originalPath: result.originalPath,
                requiresSaveAsOnFirstSave: state.requiresSaveAsOnFirstSave.value,
            });
            return outcome;
        } catch (e) {
            if (!isCurrentOpenRequest(openRequestId)) {
                return {
                    status: 'failed',
                    error: classifyOpenError(e, path),
                } satisfies TDocumentOpenOutcome;
            }
            const message = classifyOpenError(e, path);
            state.error.value = message;
            BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'openFileDirect failed', {
                path,
                error: getErrorMessage(e),
            });
            return {
                status: 'failed',
                error: message,
            } satisfies TDocumentOpenOutcome;
        }
    }

    function classifyOpenError(e: unknown, path: TDocumentRef | null) {
        const rawMessage = e instanceof Error ? e.message : '';
        if (rawMessage && /ENOENT|could not be found|no such file|chunk missing|does not exist/i.test(rawMessage)) {
            const baseName = path ? getDocumentRefBaseName(path) : '';
            const name = baseName && baseName.length > 0 ? baseName : path ? String(path) : '';
            return deps.t('errors.file.openNotFound', { name });
        }
        return rawMessage || deps.t('errors.file.open');
    }

    async function openFileDirectBatch(paths: TDocumentRef[]) {
        const openRequestId = beginOpenRequest();
        state.error.value = null;
        state.pendingDjvu.value = null;
        state.openBatchProgress.value = null;
        try {
            const documentOpen = getDocumentOpenCapability();
            const documentMenu = getDocumentMenuCapability();
            const normalizedPaths = paths
                .map((path) => path.trim())
                .filter((path) => path.length > 0);

            if (normalizedPaths.length === 0) {
                const message = deps.t('errors.file.invalid');
                if (isCurrentOpenRequest(openRequestId)) {
                    state.error.value = message;
                }
                return {
                    status: 'failed',
                    error: message,
                } satisfies TDocumentOpenOutcome;
            }

            const requestId = crypto.randomUUID();
            state.openBatchProgress.value = {
                processed: 0,
                total: normalizedPaths.length,
                percent: 0,
                elapsedMs: 0,
                estimatedRemainingMs: null,
            };

            const stopProgress = documentMenu.onOpenDocumentDirectBatchProgress(
                (progress) => {
                    if (
                        progress.operation !== 'document-open'
                        || progress.requestId !== requestId
                        || !isCurrentOpenRequest(openRequestId)
                    ) {
                        return;
                    }

                    state.openBatchProgress.value = {
                        processed: Math.max(0, progress.processed),
                        total: Math.max(0, progress.total),
                        percent: clamp(progress.percent, 0, 100),
                        elapsedMs: Math.max(0, progress.elapsedMs),
                        estimatedRemainingMs:
                            typeof progress.estimatedRemainingMs === 'number'
                                ? Math.max(0, progress.estimatedRemainingMs)
                                : null,
                    };
                },
            );

            let result: TOpenFileResult | null = null;
            try {
                result = await documentOpen.openDocumentDirectBatch(
                    normalizedPaths,
                    requestId,
                );
            } finally {
                stopProgress();
            }

            if (!isCurrentOpenRequest(openRequestId)) {
                if (result) {
                    await cleanupAbandonedPdfWorkingCopy(result, 'stale-batch-result');
                    return {
                        status: 'stale',
                        result,
                    } satisfies TDocumentOpenOutcome;
                }
                return {
                    status: 'failed',
                    error: deps.t('errors.file.invalid'),
                } satisfies TDocumentOpenOutcome;
            }
            if (!result) {
                state.openBatchProgress.value = null;
                const message = deps.t('errors.file.invalid');
                state.error.value = message;
                return {
                    status: 'failed',
                    error: message,
                } satisfies TDocumentOpenOutcome;
            }
            if (result.kind === 'djvu') {
                state.openBatchProgress.value = null;
                state.pendingDjvu.value = result.originalPath;
                await trackOpenedDocument(result, 'batch');
                return {
                    status: 'opened',
                    result,
                } satisfies TDocumentOpenOutcome;
            }
            state.openBatchProgress.value = null;
            return await finishPdfOpenResult(openRequestId, result, 'batch');
        } catch (e) {
            if (!isCurrentOpenRequest(openRequestId)) {
                return {
                    status: 'failed',
                    error: e instanceof Error ? e.message : deps.t('errors.file.open'),
                } satisfies TDocumentOpenOutcome;
            }
            state.openBatchProgress.value = null;
            const message = e instanceof Error ? e.message : deps.t('errors.file.open');
            state.error.value = message;
            return {
                status: 'failed',
                error: message,
            } satisfies TDocumentOpenOutcome;
        }
    }

    async function applyLoadedPdfState(
        path: TDocumentRef,
        nextState: IPdfLoadedState,
        options?: {
            markDirty?: boolean;
            preserveHistory?: boolean;
            previousPath?: TDocumentRef | null;
            isCurrent?: (() => boolean) | undefined;
        },
    ) {
        if (options?.isCurrent?.() === false) {
            return false;
        }

        state.workingCopyPath.value = path;
        state.pdfData.value = nextState.pdfData;
        state.pdfSrc.value = nextState.pdfSrc;
        state.pdfReloadSrc.value = nextState.pdfSrc;
        deps.clearPdfConformanceProfile();

        if (!options?.preserveHistory) {
            deps.incrementSessionVersion();
            if (nextState.pdfData) {
                const didResetHistory = await deps.resetHistory(nextState.pdfData, {
                    reuseSnapshot: true,
                    isCurrent: options?.isCurrent,
                });
                if (!didResetHistory || options?.isCurrent?.() === false) {
                    return false;
                }
                deps.syncDirtyFromHistory();
            } else {
                const didResetHistory = await deps.resetHistory(null, { isCurrent: options?.isCurrent });
                if (!didResetHistory || options?.isCurrent?.() === false) {
                    return false;
                }
            }
        }

        if (options?.isCurrent?.() === false) {
            return false;
        }

        if (typeof options?.markDirty === 'boolean') {
            state.isDirty.value = options.markDirty;
        }

        if (
            options?.previousPath
            && options.previousPath !== path
            && options.isCurrent?.() !== false
        ) {
            await deps.cleanupPreviousWorkingCopy(options.previousPath, path);
            if (options.isCurrent?.() === false) {
                return false;
            }
        }

        deps.deferPdfConformanceProfile(path, { fileSize: getLoadedPdfFileSize(nextState) });
        return true;
    }

    async function readPdfStateFromPath(path: TDocumentRef): Promise<IPdfLoadedState> {
        const { size } = await getDocumentFilesCapability().statFile(path);
        assertPdfHasBytes(size);

        if (size > MAX_IN_MEMORY_PDF_BYTES) {
            return {
                pdfData: null,
                pdfSrc: {
                    kind: 'path' as const,
                    path,
                    size,
                },
            };
        }

        const data = await readDocumentBytes(path, {
            knownSize: size,
            maxBytes: MAX_IN_MEMORY_PDF_BYTES,
        });
        return {
            pdfData: data,
            pdfSrc: toPdfBlob(data) as TPdfSource,
        };
    }

    async function loadPdfFromPath(path: TDocumentRef, opts?: {
        markDirty?: boolean;
        openRequestId?: number;
        resetSourceBeforeCommit?: boolean;
    }) {
        const requestId = deps.loadEpoch.begin();
        const isCurrent = () => (
            isCurrentLoadRequest(requestId)
            && (
                opts?.openRequestId === undefined
                || isCurrentOpenLoadRequest(opts.openRequestId, requestId)
            )
        );
        // Yield one visual frame so upstream loading indicators (e.g. the
        // workspace host spinner) can paint before the potentially heavy file
        // read blocks the renderer thread during IPC deserialization.
        await waitForVisualFrames();
        if (!isCurrent()) {
            return;
        }

        // Verify and read file BEFORE committing any reactive state.
        // This prevents an inconsistent UI where the tab shows metadata
        // (filename, dirty dot) but the content area shows the empty state
        // because pdfSrc remained unset after a failed read.
        // Only the file state is needed for rendering; conformance analysis
        // (used only for save restrictions) is deferred so it does not block
        // the initial display of the document.
        const nextState = await readPdfStateFromPath(path);

        if (!isCurrent()) {
            BrowserLogger.debug('pdf-file', 'Skipped stale PDF load result', {
                path,
                requestId,
                currentLoadRequestId: deps.loadEpoch.current(),
            });
            return;
        }

        if (opts?.resetSourceBeforeCommit && state.pdfSrc.value) {
            state.pdfSrc.value = null;
            state.pdfReloadSrc.value = null;
            await nextTick();
            if (!isCurrent()) {
                return;
            }
        }

        // Keep the previous working copy until the new file is fully validated and loaded.
        // This avoids dropping recoverable state when opening the next file fails midway.
        await applyLoadedPdfState(path, nextState, {
            isCurrent,
            markDirty: !!opts?.markDirty,
            previousPath: state.workingCopyPath.value,
        });
    }

    async function applySnapshot(
        snapshot: Uint8Array,
        persist = false,
        expectedWorkingPath: TDocumentRef | null = state.workingCopyPath.value,
    ) {
        if (expectedWorkingPath !== state.workingCopyPath.value) {
            return false;
        }
        if (persist && expectedWorkingPath) {
            await getDocumentFilesCapability().writeFile(expectedWorkingPath, snapshot);
            if (!state.isActiveWorkingCopy(expectedWorkingPath)) {
                return false;
            }
        }

        state.pdfData.value = snapshot;
        state.pdfSrc.value = toPdfBlob(snapshot);
        state.pdfReloadSrc.value = state.pdfSrc.value;
        return true;
    }

    async function loadPdfFromData(
        data: Uint8Array,
        opts?: {
            pushHistory?: boolean;
            persistWorkingCopy?: boolean;
        },
    ) {
        const requestId = deps.loadEpoch.begin();
        const expectedWorkingPath = state.workingCopyPath.value;
        const snapshot = data.slice();
        assertPdfHasBytes(snapshot.byteLength);
        if (!deps.loadEpoch.isCurrent(requestId)) {
            return;
        }
        const didApplySnapshot = await applySnapshot(
            snapshot,
            opts?.persistWorkingCopy ?? false,
            expectedWorkingPath,
        );
        if (!didApplySnapshot || !deps.loadEpoch.isCurrent(requestId)) {
            BrowserLogger.debug('pdf-file', 'Skipped stale PDF data load result', {
                requestId,
                currentLoadRequestId: deps.loadEpoch.current(),
                bytes: snapshot.byteLength,
                expectedWorkingPath,
                currentWorkingPath: state.workingCopyPath.value,
            });
            return;
        }

        if (opts?.pushHistory !== false) {
            await deps.pushHistorySnapshot(snapshot, { reuseSnapshot: true });
        } else {
            state.isDirty.value = true;
        }

        if (opts?.persistWorkingCopy && expectedWorkingPath && state.isActiveWorkingCopy(expectedWorkingPath)) {
            deps.deferPdfConformanceProfile(expectedWorkingPath);
        }
    }

    return {
        applyLoadedPdfState,
        loadPdfFromData,
        loadPdfFromPath,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        pickFileToOpen,
        readPdfStateFromPath,
        toPdfBlob,
    };
}
