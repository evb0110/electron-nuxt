import { clamp } from 'es-toolkit/math';
import { uniq } from 'es-toolkit/array';
import { useAnalytics } from '@app/composables/useAnalytics';
import { getDocumentRefBaseName } from '@app/utils/documentRef';
import { useOcrTextContent } from '@app/composables/pdf/useOcrTextContent';
import type {
    IPdfConformanceProfile,
    IPdfPersistResult,
    TPdfSaveMode,
    TPdfSource,
} from '@app/types/pdf';
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platformApi';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import { BrowserLogger } from '@app/utils/browserLogger';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import {
    bucketFileSize,
    getLowercaseExtension,
} from '@app/utils/analytics';
import { readDocumentBytes } from '@app/utils/documentBytes';
import {
    getDocumentsCapability,
    shouldRefreshWorkingCopyAfterSaveAs,
} from '@app/utils/platformDocuments';
import { getErrorMessage } from '@app/utils/error';
import {
    appendHistoryEntry,
    type IByteHistoryEntry,
    type IPathHistoryEntry,
    type TPdfHistoryEntry,
} from '@app/composables/pdfFileHistory';
import {
    readPdfConformanceProfile,
    shouldForcePdfSaveAs,
} from '@app/composables/pdfFileConformance';
import {
    createFailedPdfPersistResult,
    createPdfPersistResult,
    savePdfBytesAs,
    savePdfBytesToWorkingCopy,
} from '@app/composables/pdfFilePersistence';

interface IOpenBatchProgressState {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

const RECENT_OPEN_LOG_SECTION = 'recent-open';

export const usePdfFile = () => {
    const analytics = useAnalytics();
    const { t } = useTypedI18n();

    const pdfSrc = ref<TPdfSource | null>(null);
    const pdfData = shallowRef<Uint8Array | null>(null);
    const workingCopyPath = ref<TDocumentRef | null>(null);
    const originalPath = ref<TDocumentRef | null>(null);
    const error = ref<string | null>(null);
    const isDirty = ref(false);
    const pdfConformanceProfile = ref<IPdfConformanceProfile | null>(null);
    const lastSaveMode = ref<TPdfSaveMode>('rewrite');
    const history = shallowRef<TPdfHistoryEntry[]>([]);
    const historyIndex = ref(0);
    const historyCleanIndex = ref(-1);
    const fileHistoryMutationVersion = ref(0);
    const fileHistorySessionVersion = ref(0);
    const requiresSaveAsOnFirstSave = ref(false);
    const MAX_HISTORY_ENTRIES = 20;
    const MAX_HISTORY_BYTES = 200 * 1024 * 1024;
    let conformanceProfileRequestId = 0;

    const { clearCache: clearOcrCache } = useOcrTextContent();

    const { isDesktopRuntime } = useRuntimeEnvironment();

    const fileName = computed(
        () =>
            getDocumentRefBaseName(workingCopyPath.value) ??
      getDocumentRefBaseName(originalPath.value),
    );
    const isElectron = computed(() => isDesktopRuntime.value);

    const pendingDjvu = ref<TDocumentRef | null>(null);
    const openBatchProgress = ref<IOpenBatchProgressState | null>(null);
    let latestLoadRequestId = 0;
    let latestOpenRequestId = 0;

    function assertPdfHasBytes(size: number) {
        if (size > 0) {
            return;
        }

        throw new Error(t('errors.file.emptyPdf'));
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

    async function pickFileToOpen() {
        return getDocumentsCapability().openDocumentDialog();
    }

    async function trackOpenedDocument(
        result: TOpenFileResult,
        openMethod: 'picker' | 'preselected' | 'direct' | 'batch',
    ) {
        const fileName = getDocumentRefBaseName(result.originalPath);
        let fileSizeBucket: string | null = null;

        try {
            const { size } = await getDocumentsCapability().statFile(result.originalPath);
            fileSizeBucket = bucketFileSize(size);
        } catch {
            fileSizeBucket = null;
        }

        analytics.setDocumentContext({
            documentKind: result.kind,
            fileExtension: getLowercaseExtension(fileName),
            fileSizeBucket,
            isGenerated: result.kind === 'pdf' ? Boolean(result.isGenerated) : false,
            pageCountBucket: null,
            totalPages: null,
        });
        analytics.track('document_opened', {
            documentKind: result.kind,
            fileExtension: getLowercaseExtension(fileName),
            fileSizeBucket,
            isGenerated: result.kind === 'pdf' ? Boolean(result.isGenerated) : false,
            openMethod,
            requiresSaveAsOnFirstSave: result.kind === 'pdf' ? Boolean(result.isGenerated) : false,
        });
    }

    async function openFile(preSelected?: TOpenFileResult) {
        const openRequestId = beginOpenRequest();
        error.value = null;
        pendingDjvu.value = null;
        openBatchProgress.value = null;
        try {
            const result = preSelected ?? (await pickFileToOpen());
            if (!isCurrentOpenRequest(openRequestId)) {
                if (result) {
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
                pendingDjvu.value = result.originalPath;
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
            error.value = message;
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
        await loadPdfFromPath(result.workingPath, {
            markDirty: !!result.isGenerated,
            resetSourceBeforeCommit: true,
        });
        if (!isCurrentOpenRequest(openRequestId) || workingCopyPath.value !== result.workingPath) {
            return {
                status: 'stale',
                result,
            } satisfies TDocumentOpenOutcome;
        }
        originalPath.value = result.originalPath;
        requiresSaveAsOnFirstSave.value = !!result.isGenerated;
        await trackOpenedDocument(result, openMethod);
        return {
            status: 'opened',
            result,
        } satisfies TDocumentOpenOutcome;
    }

    async function openFileDirect(path: TDocumentRef) {
        const openRequestId = beginOpenRequest();
        error.value = null;
        pendingDjvu.value = null;
        openBatchProgress.value = null;
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'openFileDirect started', {path});
        try {
            const result = await getDocumentsCapability().openDocumentDirect(path);
            if (!isCurrentOpenRequest(openRequestId)) {
                if (result) {
                    return {
                        status: 'stale',
                        result, 
                    } satisfies TDocumentOpenOutcome;
                }
                return {
                    status: 'failed',
                    error: t('errors.file.invalid'),
                } satisfies TDocumentOpenOutcome;
            }
            if (!result) {
                const message = t('errors.file.invalid');
                error.value = message;
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
                pendingDjvu.value = result.originalPath;
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
                requiresSaveAsOnFirstSave: requiresSaveAsOnFirstSave.value,
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
            error.value = message;
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
            const name = (path && getDocumentRefBaseName(path)) || (path ? String(path) : '');
            return t('errors.file.openNotFound', { name });
        }
        return rawMessage || t('errors.file.open');
    }

    async function openFileDirectBatch(paths: TDocumentRef[]) {
        const openRequestId = beginOpenRequest();
        error.value = null;
        pendingDjvu.value = null;
        openBatchProgress.value = null;
        try {
            const documents = getDocumentsCapability();
            const normalizedPaths = paths
                .map((path) => path.trim())
                .filter((path) => path.length > 0);

            if (normalizedPaths.length === 0) {
                const message = t('errors.file.invalid');
                if (isCurrentOpenRequest(openRequestId)) {
                    error.value = message;
                }
                return {
                    status: 'failed',
                    error: message,
                } satisfies TDocumentOpenOutcome;
            }

            const requestId = crypto.randomUUID();
            openBatchProgress.value = {
                processed: 0,
                total: normalizedPaths.length,
                percent: 0,
                elapsedMs: 0,
                estimatedRemainingMs: null,
            };

            const stopProgress = documents.onOpenDocumentDirectBatchProgress(
                (progress) => {
                    if (
                        progress.requestId !== requestId
                        || !isCurrentOpenRequest(openRequestId)
                    ) {
                        return;
                    }

                    openBatchProgress.value = {
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
                result = await documents.openDocumentDirectBatch(
                    normalizedPaths,
                    requestId,
                );
            } finally {
                stopProgress();
            }

            if (!isCurrentOpenRequest(openRequestId)) {
                if (result) {
                    return {
                        status: 'stale',
                        result, 
                    } satisfies TDocumentOpenOutcome;
                }
                return {
                    status: 'failed',
                    error: t('errors.file.invalid'),
                } satisfies TDocumentOpenOutcome;
            }
            if (!result) {
                openBatchProgress.value = null;
                const message = t('errors.file.invalid');
                error.value = message;
                return {
                    status: 'failed',
                    error: message,
                } satisfies TDocumentOpenOutcome;
            }
            if (result.kind === 'djvu') {
                openBatchProgress.value = null;
                pendingDjvu.value = result.originalPath;
                await trackOpenedDocument(result, 'batch');
                return {
                    status: 'opened',
                    result,
                } satisfies TDocumentOpenOutcome;
            }
            openBatchProgress.value = null;
            return await finishPdfOpenResult(openRequestId, result, 'batch');
        } catch (e) {
            if (!isCurrentOpenRequest(openRequestId)) {
                return {
                    status: 'failed',
                    error: e instanceof Error ? e.message : t('errors.file.open'),
                } satisfies TDocumentOpenOutcome;
            }
            openBatchProgress.value = null;
            const message = e instanceof Error ? e.message : t('errors.file.open');
            error.value = message;
            return {
                status: 'failed',
                error: message,
            } satisfies TDocumentOpenOutcome;
        }
    }

    const MAX_IN_MEMORY_PDF_BYTES = 64 * 1024 * 1024;

    function createByteHistoryEntry(
        snapshot: Uint8Array,
        options?: { reuseSnapshot?: boolean },
    ): IByteHistoryEntry {
        return {
            kind: 'bytes',
            snapshot: options?.reuseSnapshot ? snapshot : snapshot.slice(),
        };
    }

    function scheduleHistoryEntryCleanup(entries: TPdfHistoryEntry[]) {
        const snapshotPaths = uniq(entries.flatMap((entry) => entry.kind === 'path' ? [entry.path] : []));

        if (snapshotPaths.length === 0) {
            return;
        }

        for (const snapshotPath of snapshotPaths) {
            getDocumentsCapability().cleanupFile(snapshotPath).catch((cleanupError: unknown) => {
                BrowserLogger.warn(
                    'pdf-file',
                    'Failed to cleanup history snapshot',
                    {
                        path: snapshotPath,
                        error: cleanupError,
                    },
                );
            });
        }
    }

    function replaceHistory(nextHistory: TPdfHistoryEntry[], nextIndex: number, nextCleanIndex: number) {
        const removedEntries = history.value.filter(entry => !nextHistory.includes(entry));
        history.value = nextHistory;
        historyIndex.value = nextIndex;
        historyCleanIndex.value = nextCleanIndex;
        scheduleHistoryEntryCleanup(removedEntries);
    }

    function resetHistory(
        snapshot: Uint8Array | null,
        options?: { reuseSnapshot?: boolean },
    ) {
        if (snapshot) {
            replaceHistory(
                [createByteHistoryEntry(snapshot, options)],
                0,
                0,
            );
        } else {
            replaceHistory([], 0, -1);
        }
    }

    function syncDirtyFromHistory() {
        if (history.value.length === 0) {
            isDirty.value = false;
            return;
        }
        isDirty.value =
            historyCleanIndex.value < 0 ||
      historyIndex.value !== historyCleanIndex.value;
    }

    function areByteArraysEqual(left: Uint8Array | null, right: Uint8Array | null) {
        if (!left || !right) {
            return false;
        }
        if (left.byteLength !== right.byteLength) {
            return false;
        }

        for (let index = 0; index < left.byteLength; index += 1) {
            if (left[index] !== right[index]) {
                return false;
            }
        }

        return true;
    }

    async function cleanupPreviousWorkingCopy(path: TDocumentRef, nextPath: TDocumentRef) {
        if (path === nextPath) {
            return;
        }

        clearOcrCache(path);
        try {
            await getDocumentsCapability().cleanupFile(path);
        } catch (cleanupError) {
            BrowserLogger.warn(
                'pdf-file',
                'Failed to cleanup previous working copy',
                {
                    path,
                    error: cleanupError,
                },
            );
        }
    }

    function clearPdfConformanceProfile() {
        conformanceProfileRequestId += 1;
        pdfConformanceProfile.value = null;
    }

    function applyPdfConformanceProfile(
        path: TDocumentRef,
        requestId: number,
        profile: IPdfConformanceProfile | null,
    ) {
        if (
            conformanceProfileRequestId === requestId
            && workingCopyPath.value === path
        ) {
            pdfConformanceProfile.value = profile;
            return true;
        }
        return false;
    }

    function deferPdfConformanceProfile(path: TDocumentRef) {
        const requestId = ++conformanceProfileRequestId;
        pdfConformanceProfile.value = null;
        readPdfConformanceProfile(path).then((profile) => {
            applyPdfConformanceProfile(path, requestId, profile);
        }).catch((conformanceError: unknown) => {
            BrowserLogger.warn('pdf-file', 'Deferred conformance analysis failed', {
                path,
                error: conformanceError,
            });
        });
    }

    async function applyLoadedPdfState(
        path: TDocumentRef,
        nextState: Awaited<ReturnType<typeof readPdfStateFromPath>>,
        options?: {
            markDirty?: boolean;
            preserveHistory?: boolean;
            previousPath?: TDocumentRef | null;
        },
    ) {
        workingCopyPath.value = path;
        pdfData.value = nextState.pdfData;
        pdfSrc.value = nextState.pdfSrc;
        clearPdfConformanceProfile();

        if (!options?.preserveHistory) {
            fileHistorySessionVersion.value += 1;
            if (nextState.pdfData) {
                resetHistory(nextState.pdfData, { reuseSnapshot: true });
                syncDirtyFromHistory();
            } else {
                resetHistory(null);
            }
        }

        if (typeof options?.markDirty === 'boolean') {
            isDirty.value = options.markDirty;
        }

        if (options?.previousPath && options.previousPath !== path) {
            await cleanupPreviousWorkingCopy(options.previousPath, path);
        }

        deferPdfConformanceProfile(path);
    }

    async function createPathHistoryEntry(
        path: TDocumentRef,
        size: number,
    ): Promise<IPathHistoryEntry> {
        const snapshotPath = await getDocumentsCapability().createWorkingCopyFromPath(
            path,
            originalPath.value ?? undefined,
        );
        return {
            kind: 'path',
            path: snapshotPath,
            size,
            originalPath: originalPath.value,
        };
    }

    async function refreshPdfConformanceProfile(path: TDocumentRef | null) {
        if (!path) {
            clearPdfConformanceProfile();
            return null;
        }

        const requestId = ++conformanceProfileRequestId;
        const profile = await readPdfConformanceProfile(path);
        applyPdfConformanceProfile(path, requestId, profile);
        return profile;
    }

    async function readPdfStateFromPath(path: TDocumentRef) {
        const { size } = await getDocumentsCapability().statFile(path);
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

    function markCurrentHistoryEntryClean(snapshot: Uint8Array | null) {
        BrowserLogger.debug('workspace', 'Marking file history clean', () => ({
            hasSnapshot: Boolean(snapshot),
            historyLength: history.value.length,
            historyIndex: historyIndex.value,
            historyCleanIndex: historyCleanIndex.value,
            isDirty: isDirty.value,
        }));
        if (!snapshot) {
            if (history.value.length === 0) {
                resetHistory(null);
            } else {
                historyCleanIndex.value = historyIndex.value;
                syncDirtyFromHistory();
            }
            isDirty.value = false;
            return;
        }

        const currentEntry = history.value[historyIndex.value] ?? null;
        if (currentEntry?.kind === 'bytes' && !areByteArraysEqual(currentEntry.snapshot, snapshot)) {
            pushHistorySnapshot(snapshot, { reuseSnapshot: true });
        } else if (!currentEntry) {
            resetHistory(snapshot, { reuseSnapshot: true });
        }

        historyCleanIndex.value = historyIndex.value;
        syncDirtyFromHistory();
        isDirty.value = false;
        BrowserLogger.debug('workspace', 'File history marked clean', () => ({
            historyLength: history.value.length,
            historyIndex: historyIndex.value,
            historyCleanIndex: historyCleanIndex.value,
            isDirty: isDirty.value,
        }));
    }

    async function commitPersistedPdfState(
        snapshotHint?: Uint8Array | null,
        expectedWorkingPath?: TDocumentRef,
        opts?: { preserveLoadedSource?: boolean },
    ) {
        const path = expectedWorkingPath ?? workingCopyPath.value;
        if (!path) {
            return false;
        }
        if (!isActiveWorkingCopy(path)) {
            return false;
        }

        BrowserLogger.debug('workspace', 'Committing persisted PDF state', () => ({
            path,
            hasSnapshotHint: Boolean(snapshotHint),
            snapshotHintBytes: snapshotHint?.byteLength ?? 0,
            isDirty: isDirty.value,
            historyLength: history.value.length,
            historyIndex: historyIndex.value,
            historyCleanIndex: historyCleanIndex.value,
        }));

        if (opts?.preserveLoadedSource) {
            if (snapshotHint && snapshotHint.byteLength <= MAX_IN_MEMORY_PDF_BYTES) {
                const snapshot = snapshotHint.slice();
                if (!isActiveWorkingCopy(path)) {
                    return false;
                }
                pdfData.value = snapshot;
                markCurrentHistoryEntryClean(snapshot);
            } else {
                const nextState = await readPdfStateFromPath(path);
                if (!isActiveWorkingCopy(path)) {
                    return false;
                }
                pdfData.value = nextState.pdfData;
                markCurrentHistoryEntryClean(nextState.pdfData);
            }
        } else if (snapshotHint && snapshotHint.byteLength <= MAX_IN_MEMORY_PDF_BYTES) {
            const snapshot = snapshotHint.slice();
            if (!isActiveWorkingCopy(path)) {
                return false;
            }
            pdfData.value = snapshot;
            pdfSrc.value = toPdfBlob(snapshot);
            markCurrentHistoryEntryClean(snapshot);
        } else {
            const nextState = await readPdfStateFromPath(path);
            if (!isActiveWorkingCopy(path)) {
                return false;
            }
            pdfData.value = nextState.pdfData;
            pdfSrc.value = nextState.pdfSrc;
            markCurrentHistoryEntryClean(nextState.pdfData);
        }

        deferPdfConformanceProfile(path);
        BrowserLogger.debug('workspace', 'Committed persisted PDF state', () => ({
            path,
            isDirty: isDirty.value,
            historyLength: history.value.length,
            historyIndex: historyIndex.value,
            historyCleanIndex: historyCleanIndex.value,
        }));
        return true;
    }

    function isActiveWorkingCopy(path: TDocumentRef) {
        return workingCopyPath.value === path;
    }

    function createStalePersistResult(
        saveMode: TPdfSaveMode,
        didSaveAs: boolean,
    ): IPdfPersistResult {
        return createPersistResult(false, saveMode, didSaveAs, null);
    }

    function shouldForceSaveAs(mode: TPdfSaveMode) {
        return shouldForcePdfSaveAs(
            mode,
            pdfConformanceProfile.value,
            requiresSaveAsOnFirstSave.value,
        );
    }

    async function shouldForceSaveAsForWorkingCopy(
        mode: TPdfSaveMode,
        workingPath: TDocumentRef,
    ) {
        if (requiresSaveAsOnFirstSave.value) {
            return true;
        }
        if (!pdfConformanceProfile.value) {
            await refreshPdfConformanceProfile(workingPath);
        }
        return shouldForceSaveAs(mode);
    }

    async function loadPdfFromPath(path: TDocumentRef, opts?: {
        markDirty?: boolean;
        resetSourceBeforeCommit?: boolean;
    }) {
        const requestId = ++latestLoadRequestId;
        // Yield one visual frame so upstream loading indicators (e.g. the
        // workspace host spinner) can paint before the potentially heavy file
        // read blocks the renderer thread during IPC deserialization.
        await waitForVisualFrames();
        if (requestId !== latestLoadRequestId) {
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

        if (requestId !== latestLoadRequestId) {
            BrowserLogger.debug('pdf-file', 'Skipped stale PDF load result', {
                path,
                requestId,
                latestLoadRequestId,
            });
            return;
        }

        if (opts?.resetSourceBeforeCommit && pdfSrc.value) {
            pdfSrc.value = null;
            await nextTick();
            if (requestId !== latestLoadRequestId) {
                return;
            }
        }

        // Keep the previous working copy until the new file is fully validated and loaded.
        // This avoids dropping recoverable state when opening the next file fails midway.
        await applyLoadedPdfState(path, nextState, {
            markDirty: !!opts?.markDirty,
            previousPath: workingCopyPath.value,
        });
    }

    function beginOpenRequest() {
        latestOpenRequestId += 1;
        latestLoadRequestId += 1;
        return latestOpenRequestId;
    }

    function isCurrentOpenRequest(requestId: number) {
        return requestId === latestOpenRequestId;
    }

    async function ensureHistoryBaselineForExternalMutation() {
        if (history.value.length > 0) {
            return true;
        }

        const path = workingCopyPath.value;
        if (!path) {
            return false;
        }

        const nextState = await readPdfStateFromPath(path);
        if (!isActiveWorkingCopy(path)) {
            return false;
        }
        if (nextState.pdfData) {
            resetHistory(nextState.pdfData, { reuseSnapshot: true });
            syncDirtyFromHistory();
            return true;
        }

        const entry = await createPathHistoryEntry(path, nextState.pdfSrc.size);
        if (!isActiveWorkingCopy(path)) {
            void getDocumentsCapability().cleanupFile(entry.path);
            return false;
        }
        replaceHistory([entry], 0, 0);
        syncDirtyFromHistory();
        return true;
    }

    async function reloadWorkingCopyIntoHistory(opts?: { markDirty?: boolean }) {
        const path = workingCopyPath.value;
        if (!path) {
            return false;
        }

        const nextState = await readPdfStateFromPath(path);
        if (!isActiveWorkingCopy(path)) {
            return false;
        }

        if (nextState.pdfData) {
            pdfData.value = nextState.pdfData;
            pdfSrc.value = nextState.pdfSrc;
            pushHistorySnapshot(nextState.pdfData, { reuseSnapshot: true });
        } else {
            const snapshotEntry = await createPathHistoryEntry(path, nextState.pdfSrc.size);
            if (!isActiveWorkingCopy(path)) {
                void getDocumentsCapability().cleanupFile(snapshotEntry.path);
                return false;
            }
            pdfData.value = nextState.pdfData;
            pdfSrc.value = nextState.pdfSrc;
            pushHistoryEntry(snapshotEntry);
        }

        isDirty.value = !!opts?.markDirty;
        return true;
    }

    function pushHistoryEntry(entry: TPdfHistoryEntry) {
        const nextState = appendHistoryEntry({
            history: history.value,
            historyIndex: historyIndex.value,
            historyCleanIndex: historyCleanIndex.value,
        }, entry, {
            maxEntries: MAX_HISTORY_ENTRIES,
            maxBytes: MAX_HISTORY_BYTES,
        });

        replaceHistory(nextState.history, nextState.historyIndex, nextState.historyCleanIndex);
        fileHistoryMutationVersion.value += 1;
        syncDirtyFromHistory();
    }

    function pushHistorySnapshot(
        snapshot: Uint8Array,
        options?: { reuseSnapshot?: boolean },
    ) {
        pushHistoryEntry(createByteHistoryEntry(snapshot, options));
    }

    async function applySnapshot(
        snapshot: Uint8Array,
        persist = false,
        expectedWorkingPath: TDocumentRef | null = workingCopyPath.value,
    ) {
        if (expectedWorkingPath !== workingCopyPath.value) {
            return false;
        }
        if (persist && expectedWorkingPath) {
            await getDocumentsCapability().writeFile(expectedWorkingPath, snapshot);
            if (!isActiveWorkingCopy(expectedWorkingPath)) {
                return false;
            }
        }

        pdfData.value = snapshot;
        pdfSrc.value = toPdfBlob(snapshot);
        return true;
    }

    async function loadPdfFromData(
        data: Uint8Array,
        opts?: {
            pushHistory?: boolean;
            persistWorkingCopy?: boolean;
        },
    ) {
        const requestId = ++latestLoadRequestId;
        const expectedWorkingPath = workingCopyPath.value;
        const snapshot = data.slice();
        assertPdfHasBytes(snapshot.byteLength);
        if (requestId !== latestLoadRequestId) {
            return;
        }
        const didApplySnapshot = await applySnapshot(
            snapshot,
            opts?.persistWorkingCopy ?? false,
            expectedWorkingPath,
        );
        if (!didApplySnapshot || requestId !== latestLoadRequestId) {
            BrowserLogger.debug('pdf-file', 'Skipped stale PDF data load result', {
                requestId,
                latestLoadRequestId,
                bytes: snapshot.byteLength,
                expectedWorkingPath,
                currentWorkingPath: workingCopyPath.value,
            });
            return;
        }

        if (opts?.pushHistory !== false) {
            pushHistorySnapshot(snapshot, { reuseSnapshot: true });
        } else {
            isDirty.value = true;
        }

        if (opts?.persistWorkingCopy && expectedWorkingPath && isActiveWorkingCopy(expectedWorkingPath)) {
            deferPdfConformanceProfile(expectedWorkingPath);
        }
    }

    async function persistPdfDataSilently(data: Uint8Array) {
        const expectedWorkingPath = workingCopyPath.value;
        const snapshot = data.slice();
        if (expectedWorkingPath) {
            await getDocumentsCapability().writeFile(expectedWorkingPath, snapshot);
            if (!isActiveWorkingCopy(expectedWorkingPath)) {
                BrowserLogger.debug('pdf-file', 'Skipped stale silent PDF data persistence', {
                    expectedWorkingPath,
                    currentWorkingPath: workingCopyPath.value,
                });
                return false;
            }
        } else if (workingCopyPath.value !== null) {
            return false;
        }

        pdfData.value = snapshot;
        pdfSrc.value = toPdfBlob(snapshot);
        pushHistorySnapshot(snapshot, { reuseSnapshot: true });

        if (expectedWorkingPath) {
            deferPdfConformanceProfile(expectedWorkingPath);
        }
        return true;
    }

    async function readWorkingCopyBytes() {
        const path = workingCopyPath.value;
        if (!path) {
            return null;
        }

        try {
            const bytes = await readDocumentBytes(path);
            return isActiveWorkingCopy(path) ? bytes : null;
        } catch (readError) {
            if (!isActiveWorkingCopy(path)) {
                return null;
            }
            error.value = readError instanceof Error ? readError.message : t('errors.file.save');
            return null;
        }
    }

    function createPersistResult(
        success: boolean,
        saveMode: TPdfSaveMode,
        didSaveAs: boolean,
        outPath: TDocumentRef | null = success && !didSaveAs ? originalPath.value : null,
    ): IPdfPersistResult {
        return createPdfPersistResult(success, saveMode, didSaveAs, outPath);
    }

    function createFailedPersistResult(
        saveMode: TPdfSaveMode,
        didSaveAs: boolean,
    ): IPdfPersistResult {
        return createFailedPdfPersistResult(saveMode, didSaveAs);
    }

    async function runPersistOperation(
        saveMode: TPdfSaveMode,
        didSaveAs: boolean,
        operation: (workingPath: TDocumentRef) => Promise<IPdfPersistResult>,
        expectedWorkingPath?: TDocumentRef | null,
    ): Promise<IPdfPersistResult> {
        const workingPath = workingCopyPath.value;
        if (!workingPath) {
            return createFailedPersistResult(saveMode, didSaveAs);
        }
        if (
            expectedWorkingPath !== undefined
            && workingPath !== expectedWorkingPath
        ) {
            BrowserLogger.debug('workspace', 'Skipped stale PDF persistence request', {
                expectedWorkingPath,
                currentWorkingPath: workingPath,
                saveMode,
            });
            return createStalePersistResult(saveMode, didSaveAs);
        }

        try {
            return await operation(workingPath);
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.save');
            return createFailedPersistResult(saveMode, didSaveAs);
        }
    }

    async function saveFile(
        data: Uint8Array,
        opts?: {
            saveMode?: TPdfSaveMode;
            preserveLoadedSource?: boolean;
            expectedWorkingPath?: TDocumentRef | null;
        },
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'rewrite';
        return runPersistOperation(requestedSaveMode, false, async (workingPath) => {
            const forceSaveAs = await shouldForceSaveAsForWorkingCopy(requestedSaveMode, workingPath);
            if (!isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale PDF save before write', {
                    workingPath,
                    currentWorkingPath: workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (forceSaveAs) {
                return saveWorkingCopyAs(data, {
                    saveMode: 'save_as_rewrite',
                    expectedWorkingPath: workingPath,
                });
            }

            const validation = await savePdfBytesToWorkingCopy(workingPath, data);
            if (!isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale PDF save completion', {
                    workingPath,
                    currentWorkingPath: workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (!validation.isValid) {
                error.value = validation.errors.join('\n') || t('errors.file.save');
                return createFailedPersistResult(requestedSaveMode, false);
            }
            const commitOptions = opts?.preserveLoadedSource
                ? { preserveLoadedSource: true }
                : undefined;
            if (!await commitPersistedPdfState(data, workingPath, commitOptions)) {
                return createStalePersistResult(requestedSaveMode, false);
            }
            lastSaveMode.value = requestedSaveMode;
            return createPersistResult(true, requestedSaveMode, false);
        }, opts?.expectedWorkingPath);
    }

    async function saveWorkingCopy(
        opts?: {
            saveMode?: TPdfSaveMode;
            expectedWorkingPath?: TDocumentRef | null;
        },
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'rewrite';
        return runPersistOperation(requestedSaveMode, false, async (workingPath) => {
            const forceSaveAs = await shouldForceSaveAsForWorkingCopy(requestedSaveMode, workingPath);
            if (!isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale working-copy save before write', {
                    workingPath,
                    currentWorkingPath: workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (forceSaveAs) {
                return saveWorkingCopyAs(undefined, {
                    saveMode: 'save_as_rewrite',
                    expectedWorkingPath: workingPath,
                });
            }

            await getDocumentsCapability().saveFile(workingPath);
            if (!isActiveWorkingCopy(workingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale working-copy save completion', {
                    workingPath,
                    currentWorkingPath: workingCopyPath.value,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, false);
            }
            if (!await commitPersistedPdfState(undefined, workingPath)) {
                return createStalePersistResult(requestedSaveMode, false);
            }
            lastSaveMode.value = requestedSaveMode;
            return createPersistResult(true, requestedSaveMode, false);
        }, opts?.expectedWorkingPath);
    }

    async function saveWorkingCopyAs(
        data?: Uint8Array,
        opts?: {
            saveMode?: TPdfSaveMode;
            expectedWorkingPath?: TDocumentRef | null;
        },
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'save_as_rewrite';
        return runPersistOperation(requestedSaveMode, true, async (workingPath) => {
            const previousWorkingPath = workingPath;
            const saveAsResult = data
                ? await savePdfBytesAs(workingPath, data)
                : {
                    path: await getDocumentsCapability().savePdfAs(workingPath),
                    validation: null,
                };
            if (saveAsResult.validation && !saveAsResult.validation.isValid) {
                error.value = saveAsResult.validation.errors.join('\n') || t('errors.file.save');
                return createFailedPersistResult(requestedSaveMode, true);
            }
            if (!isActiveWorkingCopy(previousWorkingPath)) {
                BrowserLogger.debug('workspace', 'Skipped stale Save As completion', {
                    workingPath: previousWorkingPath,
                    currentWorkingPath: workingCopyPath.value,
                    savedPath: saveAsResult.path,
                    saveMode: requestedSaveMode,
                });
                return createStalePersistResult(requestedSaveMode, true);
            }
            const savedPath = saveAsResult.path;
            if (savedPath) {
                let savedWorkingPath = previousWorkingPath;
                if (shouldRefreshWorkingCopyAfterSaveAs(savedPath, previousWorkingPath)) {
                    const nextWorkingPath =
                        await getDocumentsCapability().createWorkingCopyFromPath(savedPath);
                    if (!isActiveWorkingCopy(previousWorkingPath)) {
                        BrowserLogger.debug('workspace', 'Skipped stale Save As working-copy refresh', {
                            workingPath: previousWorkingPath,
                            currentWorkingPath: workingCopyPath.value,
                            nextWorkingPath,
                            savedPath,
                            saveMode: requestedSaveMode,
                        });
                        if (!isActiveWorkingCopy(nextWorkingPath)) {
                            void getDocumentsCapability().cleanupFile(nextWorkingPath);
                        }
                        return createStalePersistResult(requestedSaveMode, true);
                    }
                    workingCopyPath.value = nextWorkingPath;
                    savedWorkingPath = nextWorkingPath;
                    if (previousWorkingPath !== nextWorkingPath) {
                        await getDocumentsCapability().cleanupFile(previousWorkingPath);
                    }
                }
                if (!isActiveWorkingCopy(savedWorkingPath)) {
                    BrowserLogger.debug('workspace', 'Skipped stale Save As state commit', {
                        workingPath: savedWorkingPath,
                        currentWorkingPath: workingCopyPath.value,
                        savedPath,
                        saveMode: requestedSaveMode,
                    });
                    return createStalePersistResult(requestedSaveMode, true);
                }
                originalPath.value = savedPath;
                requiresSaveAsOnFirstSave.value = false;
                if (!await commitPersistedPdfState(data ?? undefined, savedWorkingPath)) {
                    return createStalePersistResult(requestedSaveMode, true);
                }
                lastSaveMode.value = requestedSaveMode;
            }
            return createPersistResult(Boolean(savedPath), requestedSaveMode, true, savedPath);
        }, opts?.expectedWorkingPath);
    }

    function closeFile() {
        latestOpenRequestId += 1;
        latestLoadRequestId += 1;
        const pathToCleanup = workingCopyPath.value;

        // M4.3: Clear OCR cache for the current file before closing
        if (pathToCleanup) {
            clearOcrCache(pathToCleanup);
        }

        pdfSrc.value = null;
        pdfData.value = null;
        workingCopyPath.value = null;
        originalPath.value = null;
        error.value = null;
        isDirty.value = false;
        clearPdfConformanceProfile();
        pendingDjvu.value = null;
        openBatchProgress.value = null;
        requiresSaveAsOnFirstSave.value = false;
        analytics.clearDocumentContext();
        fileHistorySessionVersion.value += 1;
        resetHistory(null);
        if (pathToCleanup) {
            getDocumentsCapability().cleanupFile(pathToCleanup).catch((cleanupError: unknown) => {
                BrowserLogger.warn(
                    'pdf-file',
                    'Failed to cleanup closed working copy',
                    {
                        path: pathToCleanup,
                        error: cleanupError,
                    },
                );
            });
        }
    }

    function markDirty() {
        BrowserLogger.debug('workspace', 'File dirty flag set', () => ({
            isDirty: isDirty.value,
            historyLength: history.value.length,
            historyIndex: historyIndex.value,
            historyCleanIndex: historyCleanIndex.value,
            stack: new Error().stack?.split('\n').slice(1, 6),
        }));
        isDirty.value = true;
    }

    const canUndo = computed(
        () => history.value.length > 0 && historyIndex.value > 0,
    );
    const canRedo = computed(
        () =>
            history.value.length > 0 && historyIndex.value < history.value.length - 1,
    );

    async function restoreHistoryEntry(entry: TPdfHistoryEntry | undefined) {
        const restoreSessionVersion = fileHistorySessionVersion.value;
        const restoreOpenRequestId = latestOpenRequestId;

        function canApplyRestore() {
            return (
                restoreSessionVersion === fileHistorySessionVersion.value
                && restoreOpenRequestId === latestOpenRequestId
            );
        }

        if (entry?.kind === 'bytes') {
            if (!canApplyRestore()) {
                return;
            }
            const workingPath = workingCopyPath.value;
            if (workingPath) {
                await getDocumentsCapability().writeFile(workingPath, entry.snapshot);
            }
            if (!canApplyRestore()) {
                return;
            }
            pdfData.value = entry.snapshot;
            pdfSrc.value = toPdfBlob(entry.snapshot);
            return;
        }

        if (entry?.kind !== 'path') {
            return;
        }

        const nextWorkingPath = await getDocumentsCapability().createWorkingCopyFromPath(
            entry.path,
            originalPath.value ?? entry.originalPath ?? undefined,
        );
        if (!canApplyRestore()) {
            void getDocumentsCapability().cleanupFile(nextWorkingPath);
            return;
        }
        const previousPath = workingCopyPath.value;
        const nextState = await readPdfStateFromPath(nextWorkingPath);
        if (!canApplyRestore()) {
            void getDocumentsCapability().cleanupFile(nextWorkingPath);
            return;
        }
        await applyLoadedPdfState(nextWorkingPath, nextState, {
            preserveHistory: true,
            previousPath,
        });
    }

    async function undo() {
        if (!canUndo.value) {
            return false;
        }
        historyIndex.value -= 1;
        await restoreHistoryEntry(history.value[historyIndex.value]);
        syncDirtyFromHistory();
        return true;
    }

    async function redo() {
        if (!canRedo.value) {
            return false;
        }
        historyIndex.value += 1;
        await restoreHistoryEntry(history.value[historyIndex.value]);
        syncDirtyFromHistory();
        return true;
    }

    return {
        pdfSrc,
        pdfData,
        workingCopyPath,
        originalPath,
        fileName,
        error,
        isDirty,
        pdfConformanceProfile,
        lastSaveMode,
        isElectron,
        pendingDjvu,
        openBatchProgress,
        pickFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        loadPdfFromPath,
        ensureHistoryBaselineForExternalMutation,
        reloadWorkingCopyIntoHistory,
        loadPdfFromData,
        persistPdfDataSilently,
        readWorkingCopyBytes,
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        closeFile,
        markDirty,
        canUndo,
        canRedo,
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        undo,
        redo,
    };
};
