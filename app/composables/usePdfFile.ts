import { clamp } from 'es-toolkit/math';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/platform';
import { useAnalytics } from '@app/composables/useAnalytics';
import { getDocumentRefBaseName } from '@app/utils/document-ref';
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
} from '@contracts/platform-api';
import { BrowserLogger } from '@app/utils/browser-logger';
import { waitForVisualFrames } from '@app/utils/async-helpers';
import {
    bucketFileSize,
    getLowercaseExtension,
} from '@app/utils/analytics';
import { readDocumentBytes } from '@app/utils/document-bytes';

interface IOpenBatchProgressState {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface IByteHistoryEntry {
    kind: 'bytes';
    snapshot: Uint8Array;
}

interface IPathHistoryEntry {
    kind: 'path';
    path: TDocumentRef;
    size: number;
    originalPath: TDocumentRef | null;
}

type TPdfHistoryEntry = IByteHistoryEntry | IPathHistoryEntry;

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

    const { clearCache: clearOcrCache } = useOcrTextContent();

    const fileName = computed(
        () =>
            getDocumentRefBaseName(workingCopyPath.value) ??
      getDocumentRefBaseName(originalPath.value),
    );
    const isElectron = computed(() => hasElectronAPI());

    const pendingDjvu = ref<TDocumentRef | null>(null);
    const openBatchProgress = ref<IOpenBatchProgressState | null>(null);
    let latestLoadRequestId = 0;

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
        const api = getElectronAPI();
        return api.documents.openPdfDialog();
    }

    async function trackOpenedDocument(
        result: TOpenFileResult,
        openMethod: 'picker' | 'preselected' | 'direct' | 'batch',
    ) {
        const fileName = getDocumentRefBaseName(result.originalPath);
        let fileSizeBucket: string | null = null;

        try {
            const { size } = await getElectronAPI().documents.statFile(result.originalPath);
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
        error.value = null;
        pendingDjvu.value = null;
        openBatchProgress.value = null;
        try {
            const result = preSelected ?? (await pickFileToOpen());
            if (!result) {
                return;
            }
            if (result.kind === 'djvu') {
                pendingDjvu.value = result.originalPath;
                await trackOpenedDocument(result, preSelected ? 'preselected' : 'picker');
                return;
            }
            await loadPdfFromPath(result.workingPath, {markDirty: !!result.isGenerated});
            if (workingCopyPath.value !== result.workingPath) {
                return;
            }
            originalPath.value = result.originalPath;
            requiresSaveAsOnFirstSave.value = !!result.isGenerated;
            await trackOpenedDocument(result, preSelected ? 'preselected' : 'picker');
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.open');
        }
    }

    async function openFileDirect(path: TDocumentRef) {
        error.value = null;
        pendingDjvu.value = null;
        openBatchProgress.value = null;
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'openFileDirect started', {path});
        try {
            const api = getElectronAPI();
            const result = await api.documents.openPdfDirect(path);
            if (!result) {
                error.value = t('errors.file.invalid');
                BrowserLogger.warn(
                    RECENT_OPEN_LOG_SECTION,
                    'openPdfDirect returned null',
                    { path },
                );
                return;
            }

            BrowserLogger.debug(
                RECENT_OPEN_LOG_SECTION,
                'openPdfDirect returned result',
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
                return;
            }

            BrowserLogger.debug(
                RECENT_OPEN_LOG_SECTION,
                'Loading PDF from working path',
                {
                    path,
                    workingPath: result.workingPath,
                },
            );
            await loadPdfFromPath(result.workingPath, {markDirty: !!result.isGenerated});
            if (workingCopyPath.value !== result.workingPath) {
                BrowserLogger.debug(
                    RECENT_OPEN_LOG_SECTION,
                    'openFileDirect skipped stale load result',
                    {
                        path,
                        workingPath: result.workingPath,
                    },
                );
                return;
            }
            originalPath.value = result.originalPath;
            requiresSaveAsOnFirstSave.value = !!result.isGenerated;
            await trackOpenedDocument(result, 'direct');
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'openFileDirect completed', {
                path,
                workingPath: result.workingPath,
                originalPath: result.originalPath,
                requiresSaveAsOnFirstSave: requiresSaveAsOnFirstSave.value,
            });
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.open');
            BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'openFileDirect failed', {
                path,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    async function openFileDirectBatch(paths: TDocumentRef[]) {
        error.value = null;
        pendingDjvu.value = null;
        openBatchProgress.value = null;
        try {
            const api = getElectronAPI();
            const normalizedPaths = paths
                .map((path) => path.trim())
                .filter((path) => path.length > 0);

            if (normalizedPaths.length === 0) {
                error.value = t('errors.file.invalid');
                return;
            }

            const requestId = crypto.randomUUID();
            openBatchProgress.value = {
                processed: 0,
                total: normalizedPaths.length,
                percent: 0,
                elapsedMs: 0,
                estimatedRemainingMs: null,
            };

            const stopProgress = api.documents.onOpenPdfDirectBatchProgress(
                (progress) => {
                    if (progress.requestId !== requestId) {
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
                result = await api.documents.openPdfDirectBatch(
                    normalizedPaths,
                    requestId,
                );
            } finally {
                stopProgress();
            }

            if (!result) {
                openBatchProgress.value = null;
                error.value = t('errors.file.invalid');
                return;
            }
            if (result.kind === 'djvu') {
                openBatchProgress.value = null;
                pendingDjvu.value = result.originalPath;
                await trackOpenedDocument(result, 'batch');
                return;
            }
            await loadPdfFromPath(result.workingPath, {markDirty: !!result.isGenerated});
            if (workingCopyPath.value !== result.workingPath) {
                openBatchProgress.value = null;
                return;
            }
            originalPath.value = result.originalPath;
            requiresSaveAsOnFirstSave.value = !!result.isGenerated;
            openBatchProgress.value = null;
            await trackOpenedDocument(result, 'batch');
        } catch (e) {
            openBatchProgress.value = null;
            error.value = e instanceof Error ? e.message : t('errors.file.open');
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

    function getHistoryBytes(entries: TPdfHistoryEntry[]) {
        return entries.reduce(
            (total, entry) => total + (entry.kind === 'bytes' ? entry.snapshot.byteLength : 0),
            0,
        );
    }

    function scheduleHistoryEntryCleanup(entries: TPdfHistoryEntry[]) {
        const snapshotPaths = Array.from(
            new Set(
                entries.flatMap((entry) => entry.kind === 'path' ? [entry.path] : []),
            ),
        );

        if (snapshotPaths.length === 0) {
            return;
        }

        const api = getElectronAPI();
        for (const snapshotPath of snapshotPaths) {
            api.documents.cleanupFile(snapshotPath).catch((cleanupError: unknown) => {
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
            await getElectronAPI().documents.cleanupFile(path);
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

    function deferPdfConformanceProfile(path: TDocumentRef) {
        readPdfConformanceProfile(path).then((profile) => {
            if (workingCopyPath.value === path) {
                pdfConformanceProfile.value = profile;
            }
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
        pdfConformanceProfile.value = null;

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
        const api = getElectronAPI();
        const snapshotPath = await api.documents.createWorkingCopyFromPath(
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

    async function readPdfConformanceProfile(path: TDocumentRef) {
        try {
            return await getElectronAPI().documents.analyzePdfConformance(path);
        } catch (conformanceError) {
            BrowserLogger.warn('pdf-file', 'Failed to analyze PDF conformance profile', {
                path,
                error: conformanceError,
            });
            return null;
        }
    }

    async function refreshPdfConformanceProfile(path: TDocumentRef | null) {
        if (!path) {
            pdfConformanceProfile.value = null;
            return null;
        }

        const profile = await readPdfConformanceProfile(path);
        pdfConformanceProfile.value = profile;
        return profile;
    }

    async function readPdfStateFromPath(path: TDocumentRef) {
        const api = getElectronAPI();
        const { size } = await api.documents.statFile(path);

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
    }

    async function commitPersistedPdfState(snapshotHint?: Uint8Array | null) {
        const path = workingCopyPath.value;
        if (!path) {
            return false;
        }

        if (snapshotHint && snapshotHint.byteLength <= MAX_IN_MEMORY_PDF_BYTES) {
            const snapshot = snapshotHint.slice();
            pdfData.value = snapshot;
            pdfSrc.value = toPdfBlob(snapshot) as TPdfSource;
            markCurrentHistoryEntryClean(snapshot);
        } else {
            const nextState = await readPdfStateFromPath(path);
            pdfData.value = nextState.pdfData;
            pdfSrc.value = nextState.pdfSrc;
            markCurrentHistoryEntryClean(nextState.pdfData);
        }

        await refreshPdfConformanceProfile(path);
        return true;
    }

    function shouldForceSaveAs(mode: TPdfSaveMode) {
        if (requiresSaveAsOnFirstSave.value) {
            return true;
        }
        if (!pdfConformanceProfile.value?.isSigned) {
            return false;
        }

        return mode === 'rewrite' || mode === 'save_as_rewrite';
    }

    async function loadPdfFromPath(path: TDocumentRef, opts?: { markDirty?: boolean }) {
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
        // because pdfSrc was never set due to a failed read.
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

        // Keep the previous working copy until the new file is fully validated and loaded.
        // This avoids dropping recoverable state when opening the next file fails midway.
        await applyLoadedPdfState(path, nextState, {
            markDirty: !!opts?.markDirty,
            previousPath: workingCopyPath.value,
        });
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
        if (nextState.pdfData) {
            resetHistory(nextState.pdfData, { reuseSnapshot: true });
            syncDirtyFromHistory();
            return true;
        }

        const entry = await createPathHistoryEntry(path, nextState.pdfSrc.size);
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
        pdfData.value = nextState.pdfData;
        pdfSrc.value = nextState.pdfSrc;

        if (nextState.pdfData) {
            pushHistorySnapshot(nextState.pdfData, { reuseSnapshot: true });
        } else {
            const snapshotEntry = await createPathHistoryEntry(path, nextState.pdfSrc.size);
            pushHistoryEntry(snapshotEntry);
        }

        isDirty.value = !!opts?.markDirty;
        return true;
    }

    function pushHistoryEntry(entry: TPdfHistoryEntry) {
        if (history.value.length === 0) {
            replaceHistory([entry], 0, 0);
            fileHistoryMutationVersion.value += 1;
            syncDirtyFromHistory();
            return;
        }

        const truncated = history.value.slice(0, historyIndex.value + 1);
        truncated.push(entry);

        let nextHistory = truncated;
        let nextCleanIndex = historyCleanIndex.value;
        let removedFromStart = 0;

        if (nextCleanIndex > historyIndex.value) {
            nextCleanIndex = -1;
        }

        while (nextHistory.length > MAX_HISTORY_ENTRIES) {
            nextHistory = nextHistory.slice(1);
            removedFromStart += 1;
        }

        let totalBytes = getHistoryBytes(nextHistory);
        while (nextHistory.length > 1 && totalBytes > MAX_HISTORY_BYTES) {
            const firstEntry = nextHistory[0];
            totalBytes -= firstEntry?.kind === 'bytes' ? firstEntry.snapshot.byteLength : 0;
            nextHistory = nextHistory.slice(1);
            removedFromStart += 1;
        }

        if (nextCleanIndex >= 0) {
            if (removedFromStart > nextCleanIndex) {
                nextCleanIndex = -1;
            } else {
                nextCleanIndex -= removedFromStart;
            }
        }

        replaceHistory(nextHistory, nextHistory.length - 1, nextCleanIndex);
        fileHistoryMutationVersion.value += 1;
        syncDirtyFromHistory();
    }

    function pushHistorySnapshot(
        snapshot: Uint8Array,
        options?: { reuseSnapshot?: boolean },
    ) {
        pushHistoryEntry(createByteHistoryEntry(snapshot, options));
    }

    async function applySnapshot(snapshot: Uint8Array, persist = false) {
        pdfData.value = snapshot;
        pdfSrc.value = toPdfBlob(snapshot);

        if (persist && workingCopyPath.value) {
            const api = getElectronAPI();
            await api.documents.writeFile(workingCopyPath.value, snapshot);
        }
    }

    async function loadPdfFromData(
        data: Uint8Array,
        opts?: {
            pushHistory?: boolean;
            persistWorkingCopy?: boolean;
        },
    ) {
        const snapshot = data.slice();
        await applySnapshot(snapshot, opts?.persistWorkingCopy ?? false);

        if (opts?.pushHistory !== false) {
            pushHistorySnapshot(snapshot, { reuseSnapshot: true });
        } else {
            isDirty.value = true;
        }

        if (opts?.persistWorkingCopy && workingCopyPath.value) {
            await refreshPdfConformanceProfile(workingCopyPath.value);
        }
    }

    async function persistPdfDataSilently(data: Uint8Array) {
        const snapshot = data.slice();
        pdfData.value = snapshot;
        pdfSrc.value = toPdfBlob(snapshot);
        pushHistorySnapshot(snapshot, { reuseSnapshot: true });

        if (workingCopyPath.value) {
            const api = getElectronAPI();
            await api.documents.writeFile(workingCopyPath.value, snapshot);
            await refreshPdfConformanceProfile(workingCopyPath.value);
        }
    }

    async function readWorkingCopyBytes() {
        const path = workingCopyPath.value;
        if (!path) {
            return null;
        }

        try {
            return await readDocumentBytes(path);
        } catch (readError) {
            error.value = readError instanceof Error ? readError.message : t('errors.file.save');
            return null;
        }
    }

    async function saveFile(
        data: Uint8Array,
        opts?: { saveMode?: TPdfSaveMode },
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'rewrite';
        if (!workingCopyPath.value) {
            return {
                success: false,
                outPath: null,
                saveMode: requestedSaveMode,
                didSaveAs: false,
            };
        }
        try {
            if (shouldForceSaveAs(requestedSaveMode)) {
                return await saveWorkingCopyAs(data, { saveMode: 'save_as_rewrite' });
            }

            const api = getElectronAPI();
            // First update the working copy with latest data
            await api.documents.writeFile(workingCopyPath.value, data);
            // Then save working copy back to original location
            await api.documents.saveFile(workingCopyPath.value);
            await commitPersistedPdfState(data);
            lastSaveMode.value = requestedSaveMode;
            return {
                success: true,
                outPath: originalPath.value,
                saveMode: requestedSaveMode,
                didSaveAs: false,
            };
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.save');
            return {
                success: false,
                outPath: null,
                saveMode: requestedSaveMode,
                didSaveAs: false,
            };
        }
    }

    async function saveWorkingCopy(
        opts?: { saveMode?: TPdfSaveMode },
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'rewrite';
        if (!workingCopyPath.value) {
            return {
                success: false,
                outPath: null,
                saveMode: requestedSaveMode,
                didSaveAs: false,
            };
        }
        try {
            if (shouldForceSaveAs(requestedSaveMode)) {
                return await saveWorkingCopyAs(undefined, { saveMode: 'save_as_rewrite' });
            }

            const api = getElectronAPI();
            await api.documents.saveFile(workingCopyPath.value);
            await commitPersistedPdfState();
            lastSaveMode.value = requestedSaveMode;
            return {
                success: true,
                outPath: originalPath.value,
                saveMode: requestedSaveMode,
                didSaveAs: false,
            };
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.save');
            return {
                success: false,
                outPath: null,
                saveMode: requestedSaveMode,
                didSaveAs: false,
            };
        }
    }

    async function saveWorkingCopyAs(
        data?: Uint8Array,
        opts?: { saveMode?: TPdfSaveMode },
    ): Promise<IPdfPersistResult> {
        const requestedSaveMode = opts?.saveMode ?? 'save_as_rewrite';
        if (!workingCopyPath.value) {
            return {
                success: false,
                outPath: null,
                saveMode: requestedSaveMode,
                didSaveAs: true,
            };
        }
        try {
            const api = getElectronAPI();
            const previousWorkingPath = workingCopyPath.value;
            if (data) {
                await api.documents.writeFile(workingCopyPath.value, data);
            }
            const savedPath = await api.documents.savePdfAs(workingCopyPath.value);
            if (savedPath) {
                if (!hasElectronAPI()) {
                    const nextWorkingPath =
                        await api.documents.createWorkingCopyFromPath(savedPath);
                    workingCopyPath.value = nextWorkingPath;
                    if (previousWorkingPath !== nextWorkingPath) {
                        await api.documents.cleanupFile(previousWorkingPath);
                    }
                }
                originalPath.value = savedPath;
                requiresSaveAsOnFirstSave.value = false;
                await commitPersistedPdfState(data ?? undefined);
                lastSaveMode.value = requestedSaveMode;
            }
            return {
                success: Boolean(savedPath),
                outPath: savedPath,
                saveMode: requestedSaveMode,
                didSaveAs: true,
            };
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.save');
            return {
                success: false,
                outPath: null,
                saveMode: requestedSaveMode,
                didSaveAs: true,
            };
        }
    }

    function closeFile() {
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
        pdfConformanceProfile.value = null;
        pendingDjvu.value = null;
        openBatchProgress.value = null;
        requiresSaveAsOnFirstSave.value = false;
        analytics.clearDocumentContext();
        fileHistorySessionVersion.value += 1;
        resetHistory(null);
        if (pathToCleanup) {
            const api = getElectronAPI();
            api.documents.cleanupFile(pathToCleanup).catch((cleanupError: unknown) => {
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
        isDirty.value = true;
    }

    const canUndo = computed(
        () => history.value.length > 0 && historyIndex.value > 0,
    );
    const canRedo = computed(
        () =>
            history.value.length > 0 && historyIndex.value < history.value.length - 1,
    );

    async function undo() {
        if (!canUndo.value) {
            return false;
        }
        historyIndex.value -= 1;
        const entry = history.value[historyIndex.value];
        if (entry?.kind === 'bytes') {
            await applySnapshot(entry.snapshot, true);
        } else if (entry?.kind === 'path') {
            const nextWorkingPath = await getElectronAPI().documents.createWorkingCopyFromPath(
                entry.path,
                originalPath.value ?? entry.originalPath ?? undefined,
            );
            const previousPath = workingCopyPath.value;
            const nextState = await readPdfStateFromPath(nextWorkingPath);
            await applyLoadedPdfState(nextWorkingPath, nextState, {
                preserveHistory: true,
                previousPath,
            });
        }
        syncDirtyFromHistory();
        return true;
    }

    async function redo() {
        if (!canRedo.value) {
            return false;
        }
        historyIndex.value += 1;
        const entry = history.value[historyIndex.value];
        if (entry?.kind === 'bytes') {
            await applySnapshot(entry.snapshot, true);
        } else if (entry?.kind === 'path') {
            const nextWorkingPath = await getElectronAPI().documents.createWorkingCopyFromPath(
                entry.path,
                originalPath.value ?? entry.originalPath ?? undefined,
            );
            const previousPath = workingCopyPath.value;
            const nextState = await readPdfStateFromPath(nextWorkingPath);
            await applyLoadedPdfState(nextWorkingPath, nextState, {
                preserveHistory: true,
                previousPath,
            });
        }
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
