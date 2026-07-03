import { uniq } from 'es-toolkit/array';
import type { TPdfSource } from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IDocumentsFileIoCapability,
    IDocumentsWorkingCopyCapability,
} from '@contracts/electronApiDocuments';
import type {
    IByteHistoryEntry,
    IPathHistoryEntry,
    TPdfHistoryEntry,
} from '@app/services/pdf-file/pdfHistoryEntryTypes';
import type { IDocumentSessionState } from '@app/modules/workspace-shell/composables/document-session/createDocumentSessionState';
import { appendHistoryEntry } from '@app/services/pdf-file/appendHistoryEntry';
import { areByteArraysEqual } from '@app/utils/areByteArraysEqual';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getDocumentRefBaseName } from '@app/utils/documentRef';

export interface IPdfLoadedState {
    pdfData: Uint8Array | null;
    pdfSrc: TPdfSource;
}

interface IApplyLoadedPdfStateOptions {
    markDirty?: boolean;
    preserveHistory?: boolean;
    previousPath?: TDocumentRef | null;
    isCurrent?: (() => boolean) | undefined;
}

type TDocumentHistoryFileDeps = Pick<IDocumentsFileIoCapability, 'writeFile'>;

type TDocumentHistoryWorkingCopyDeps = Pick<
    IDocumentsWorkingCopyCapability,
    'cleanupFile' | 'createWorkingCopyFromData' | 'createWorkingCopyFromPath'
>;

interface ICreateDocumentHistoryDeps {
    applyLoadedPdfState: (
        path: TDocumentRef,
        nextState: IPdfLoadedState,
        options?: IApplyLoadedPdfStateOptions,
    ) => Promise<boolean | undefined>;
    clearPdfConformanceProfile: () => void;
    clearOcrCache: (path: TDocumentRef) => void;
    deferPdfConformanceProfile: (path: TDocumentRef) => void;
    documentFiles: () => TDocumentHistoryFileDeps;
    documentWorkingCopy: () => TDocumentHistoryWorkingCopyDeps;
    getOpenEpoch: () => number;
    isCurrentOpenEpoch: (token: number) => boolean;
    readPdfStateFromPath: (path: TDocumentRef) => Promise<IPdfLoadedState>;
    toPdfBlob: (snapshot: Uint8Array) => Blob;
}

const MAX_HISTORY_ENTRIES = 20;
const MAX_HISTORY_BYTES = 200 * 1024 * 1024;
const MAX_IN_MEMORY_HISTORY_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export function createDocumentHistory(
    state: IDocumentSessionState,
    deps: ICreateDocumentHistoryDeps,
) {
    const history = shallowRef<TPdfHistoryEntry[]>([]);
    const historyIndex = ref(0);
    const historyCleanIndex = ref(-1);
    const fileHistoryMutationVersion = ref(0);
    const fileHistorySessionVersion = ref(0);

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
            deps.documentWorkingCopy().cleanupFile(snapshotPath).catch((cleanupError: unknown) => {
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

    function clearHistory() {
        replaceHistory([], 0, -1);
    }

    async function resetHistory(
        snapshot: Uint8Array | null,
        options?: {
            reuseSnapshot?: boolean;
            isCurrent?: (() => boolean) | undefined;
        },
    ) {
        if (options?.isCurrent?.() === false) {
            return false;
        }

        if (snapshot) {
            const entry = await createHistoryEntryFromSnapshot(snapshot, options);
            if (entry) {
                if (options?.isCurrent?.() === false) {
                    scheduleHistoryEntryCleanup([entry]);
                    return false;
                }
                replaceHistory([entry], 0, 0);
                return true;
            }
            return false;
        } else {
            if (options?.isCurrent?.() === false) {
                return false;
            }
            clearHistory();
            return true;
        }
    }

    function syncDirtyFromHistory() {
        if (history.value.length === 0) {
            state.isDirty.value = false;
            return;
        }
        state.isDirty.value =
            historyCleanIndex.value < 0 ||
            historyIndex.value !== historyCleanIndex.value;
    }

    async function cleanupPreviousWorkingCopy(path: TDocumentRef, nextPath: TDocumentRef) {
        if (path === nextPath) {
            return;
        }

        deps.clearOcrCache(path);
        try {
            await deps.documentWorkingCopy().cleanupFile(path);
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

    async function createPathHistoryEntry(
        path: TDocumentRef,
        size: number,
    ): Promise<IPathHistoryEntry> {
        const snapshotPath = await deps.documentWorkingCopy().createWorkingCopyFromPath(
            path,
            state.originalPath.value ?? undefined,
        );
        return {
            kind: 'path',
            path: snapshotPath,
            size,
            originalPath: state.originalPath.value,
        };
    }

    function shouldStoreHistorySnapshotOnDisk(snapshot: Uint8Array) {
        return (
            state.isElectron.value
            && snapshot.byteLength > MAX_IN_MEMORY_HISTORY_SNAPSHOT_BYTES
            && typeof deps.documentWorkingCopy().createWorkingCopyFromData === 'function'
        );
    }

    function getHistorySnapshotFileName() {
        return state.fileName.value ?? getDocumentRefBaseName(state.workingCopyPath.value) ?? 'document.pdf';
    }

    async function createPathHistoryEntryFromSnapshot(
        snapshot: Uint8Array,
        expectedWorkingPath: TDocumentRef,
    ): Promise<IPathHistoryEntry | null> {
        const snapshotPath = await deps.documentWorkingCopy().createWorkingCopyFromData(
            getHistorySnapshotFileName(),
            snapshot,
            state.originalPath.value ?? undefined,
        );
        if (!state.isActiveWorkingCopy(expectedWorkingPath)) {
            void deps.documentWorkingCopy().cleanupFile(snapshotPath);
            return null;
        }
        return {
            kind: 'path',
            path: snapshotPath,
            size: snapshot.byteLength,
            originalPath: state.originalPath.value,
        };
    }

    async function createHistoryEntryFromSnapshot(
        snapshot: Uint8Array,
        options?: { reuseSnapshot?: boolean },
    ): Promise<TPdfHistoryEntry | null> {
        const expectedWorkingPath = state.workingCopyPath.value;
        if (expectedWorkingPath && shouldStoreHistorySnapshotOnDisk(snapshot)) {
            try {
                const entry = await createPathHistoryEntryFromSnapshot(snapshot, expectedWorkingPath);
                if (entry) {
                    return entry;
                }
            } catch (snapshotError) {
                BrowserLogger.warn('pdf-file', 'Failed to create disk-backed history snapshot', {
                    path: expectedWorkingPath,
                    bytes: snapshot.byteLength,
                    error: snapshotError,
                });
            }
        }

        if (expectedWorkingPath && !state.isActiveWorkingCopy(expectedWorkingPath)) {
            return null;
        }
        return createByteHistoryEntry(snapshot, options);
    }

    async function markCurrentHistoryEntryClean(
        snapshot: Uint8Array | null,
        options?: { recordSnapshotChange?: boolean },
    ) {
        BrowserLogger.debug('workspace', 'Marking file history clean', () => ({
            hasSnapshot: Boolean(snapshot),
            historyLength: history.value.length,
            historyIndex: historyIndex.value,
            historyCleanIndex: historyCleanIndex.value,
            isDirty: state.isDirty.value,
            recordSnapshotChange: options?.recordSnapshotChange !== false,
        }));
        if (!snapshot) {
            if (history.value.length === 0) {
                clearHistory();
            } else {
                historyCleanIndex.value = historyIndex.value;
                syncDirtyFromHistory();
            }
            state.isDirty.value = false;
            return;
        }

        const currentEntry = history.value[historyIndex.value] ?? null;
        if (currentEntry?.kind === 'bytes' && !areByteArraysEqual(currentEntry.snapshot, snapshot)) {
            if (options?.recordSnapshotChange === false) {
                // Annotation-only preserved-source saves update the clean file
                // baseline; they must not become file undo entries and steal
                // undo/redo from app-managed annotation history.
                const entry = await createHistoryEntryFromSnapshot(snapshot, { reuseSnapshot: true });
                if (!entry) {
                    return;
                }
                const nextHistory = history.value.slice();
                nextHistory[historyIndex.value] = entry;
                replaceHistory(nextHistory, historyIndex.value, historyIndex.value);
            } else {
                await pushHistorySnapshot(snapshot, { reuseSnapshot: true });
            }
        } else if (currentEntry?.kind === 'path' && options?.recordSnapshotChange === false) {
            const entry = await createHistoryEntryFromSnapshot(snapshot, { reuseSnapshot: true });
            if (!entry) {
                return;
            }
            const nextHistory = history.value.slice();
            nextHistory[historyIndex.value] = entry;
            replaceHistory(nextHistory, historyIndex.value, historyIndex.value);
        } else if (!currentEntry) {
            await resetHistory(snapshot, { reuseSnapshot: true });
        }

        historyCleanIndex.value = historyIndex.value;
        syncDirtyFromHistory();
        state.isDirty.value = false;
        BrowserLogger.debug('workspace', 'File history marked clean', () => ({
            historyLength: history.value.length,
            historyIndex: historyIndex.value,
            historyCleanIndex: historyCleanIndex.value,
            isDirty: state.isDirty.value,
        }));
    }

    async function ensureHistoryBaselineForExternalMutation() {
        if (history.value.length > 0) {
            return true;
        }

        const path = state.workingCopyPath.value;
        if (!path) {
            return false;
        }

        const nextState = await deps.readPdfStateFromPath(path);
        if (!state.isActiveWorkingCopy(path)) {
            return false;
        }
        if (nextState.pdfData) {
            await resetHistory(nextState.pdfData, { reuseSnapshot: true });
            syncDirtyFromHistory();
            return true;
        }

        const entry = await createPathHistoryEntry(path, nextState.pdfSrc.size);
        if (!state.isActiveWorkingCopy(path)) {
            void deps.documentWorkingCopy().cleanupFile(entry.path);
            return false;
        }
        replaceHistory([entry], 0, 0);
        syncDirtyFromHistory();
        return true;
    }

    async function reloadWorkingCopyIntoHistory(opts?: { markDirty?: boolean }) {
        const path = state.workingCopyPath.value;
        if (!path) {
            return false;
        }

        const nextState = await deps.readPdfStateFromPath(path);
        if (!state.isActiveWorkingCopy(path)) {
            return false;
        }

        if (nextState.pdfData) {
            state.pdfData.value = nextState.pdfData;
            state.pdfSrc.value = nextState.pdfSrc;
            state.pdfReloadSrc.value = nextState.pdfSrc;
            await pushHistorySnapshot(nextState.pdfData, { reuseSnapshot: true });
        } else {
            const snapshotEntry = await createPathHistoryEntry(path, nextState.pdfSrc.size);
            if (!state.isActiveWorkingCopy(path)) {
                void deps.documentWorkingCopy().cleanupFile(snapshotEntry.path);
                return false;
            }
            state.pdfData.value = nextState.pdfData;
            state.pdfSrc.value = nextState.pdfSrc;
            state.pdfReloadSrc.value = nextState.pdfSrc;
            pushHistoryEntry(snapshotEntry);
        }

        state.isDirty.value = !!opts?.markDirty;
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

    async function pushHistorySnapshot(
        snapshot: Uint8Array,
        options?: { reuseSnapshot?: boolean },
    ) {
        const entry = await createHistoryEntryFromSnapshot(snapshot, options);
        if (!entry) {
            return false;
        }
        pushHistoryEntry(entry);
        return true;
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
        const restoreOpenRequestId = deps.getOpenEpoch();

        function canApplyRestore() {
            return (
                restoreSessionVersion === fileHistorySessionVersion.value
                && deps.isCurrentOpenEpoch(restoreOpenRequestId)
            );
        }

        if (entry?.kind === 'bytes') {
            if (!canApplyRestore()) {
                return false;
            }
            const workingPath = state.workingCopyPath.value;
            if (workingPath) {
                await deps.documentFiles().writeFile(workingPath, entry.snapshot);
            }
            if (!canApplyRestore()) {
                return false;
            }
            state.pdfData.value = entry.snapshot;
            state.pdfSrc.value = deps.toPdfBlob(entry.snapshot);
            state.pdfReloadSrc.value = state.pdfSrc.value;
            if (workingPath && state.isActiveWorkingCopy(workingPath)) {
                deps.deferPdfConformanceProfile(workingPath);
            } else {
                deps.clearPdfConformanceProfile();
            }
            return true;
        }

        if (entry?.kind !== 'path') {
            return false;
        }

        const nextWorkingPath = await deps.documentWorkingCopy().createWorkingCopyFromPath(
            entry.path,
            state.originalPath.value ?? entry.originalPath ?? undefined,
        );
        if (!canApplyRestore()) {
            void deps.documentWorkingCopy().cleanupFile(nextWorkingPath);
            return false;
        }
        const previousPath = state.workingCopyPath.value;
        const nextState = await deps.readPdfStateFromPath(nextWorkingPath);
        if (!canApplyRestore()) {
            void deps.documentWorkingCopy().cleanupFile(nextWorkingPath);
            return false;
        }
        const didApply = await deps.applyLoadedPdfState(nextWorkingPath, nextState, {
            preserveHistory: true,
            previousPath,
        });
        return didApply !== false;
    }

    async function undo() {
        if (!canUndo.value) {
            return false;
        }
        const nextHistoryIndex = historyIndex.value - 1;
        const restored = await restoreHistoryEntry(history.value[nextHistoryIndex]);
        if (!restored) {
            return false;
        }
        historyIndex.value = nextHistoryIndex;
        syncDirtyFromHistory();
        return true;
    }

    async function redo() {
        if (!canRedo.value) {
            return false;
        }
        const nextHistoryIndex = historyIndex.value + 1;
        const restored = await restoreHistoryEntry(history.value[nextHistoryIndex]);
        if (!restored) {
            return false;
        }
        historyIndex.value = nextHistoryIndex;
        syncDirtyFromHistory();
        return true;
    }

    function incrementSessionVersion() {
        fileHistorySessionVersion.value += 1;
    }

    function getHistoryDebugState() {
        return {
            historyLength: history.value.length,
            historyIndex: historyIndex.value,
            historyCleanIndex: historyCleanIndex.value,
        };
    }

    return {
        canRedo,
        canUndo,
        cleanupPreviousWorkingCopy,
        clearHistory,
        ensureHistoryBaselineForExternalMutation,
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        getHistoryDebugState,
        incrementSessionVersion,
        markCurrentHistoryEntryClean,
        pushHistoryEntry,
        pushHistorySnapshot,
        redo,
        reloadWorkingCopyIntoHistory,
        resetHistory,
        syncDirtyFromHistory,
        undo,
    };
}
