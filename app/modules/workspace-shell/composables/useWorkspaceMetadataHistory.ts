import { isEqual } from 'es-toolkit/predicate';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdf';
import {
    buildPageLabelsFromRanges,
    isImplicitDefaultPageLabels,
} from '@app/utils/pdfPageLabels';
import { maxWorkspaceMetadataHistoryEntries } from '@app/modules/workspace-shell/metadata/maxWorkspaceMetadataHistoryEntries';

interface IWorkspaceMetadataSnapshot {
    bookmarkItems: IPdfBookmarkEntry[];
    pageLabelRanges: IPdfPageLabelRange[];
}

export const useWorkspaceMetadataHistory = (deps: {
    bookmarkItems: Ref<IPdfBookmarkEntry[]>;
    bookmarksDirty: Ref<boolean>;
    pageLabels: Ref<string[] | null>;
    pageLabelRanges: Ref<IPdfPageLabelRange[]>;
    pageLabelsDirty: Ref<boolean>;
    totalPages: Ref<number>;
}) => {
    const history = shallowRef<IWorkspaceMetadataSnapshot[]>([]);
    const historyIndex = ref(-1);
    const cleanSnapshot = shallowRef<IWorkspaceMetadataSnapshot | null>(null);
    const preservedReloadSnapshot = shallowRef<IWorkspaceMetadataSnapshot | null>(null);
    const isApplyingSnapshot = ref(false);
    const metadataHistoryMutationVersion = ref(0);
    const metadataHistoryResetVersion = ref(0);

    function cloneSnapshot(
        snapshot: IWorkspaceMetadataSnapshot,
    ): IWorkspaceMetadataSnapshot {
        return {
            bookmarkItems: structuredClone(toRaw(snapshot.bookmarkItems)),
            pageLabelRanges: structuredClone(toRaw(snapshot.pageLabelRanges)),
        };
    }

    function captureCurrentSnapshot(): IWorkspaceMetadataSnapshot {
        return cloneSnapshot({
            bookmarkItems: deps.bookmarkItems.value,
            pageLabelRanges: deps.pageLabelRanges.value,
        });
    }

    function syncDirtyFlags(snapshot: IWorkspaceMetadataSnapshot) {
        const baseline = cleanSnapshot.value;
        if (!baseline) {
            deps.bookmarksDirty.value = false;
            deps.pageLabelsDirty.value = false;
            return;
        }

        deps.bookmarksDirty.value = !isEqual(snapshot.bookmarkItems, baseline.bookmarkItems);
        deps.pageLabelsDirty.value = !isEqual(snapshot.pageLabelRanges, baseline.pageLabelRanges);
    }

    function applySnapshot(snapshot: IWorkspaceMetadataSnapshot) {
        isApplyingSnapshot.value = true;
        try {
            deps.bookmarkItems.value = structuredClone(snapshot.bookmarkItems);
            deps.pageLabelRanges.value = structuredClone(snapshot.pageLabelRanges);
            deps.pageLabels.value = deps.totalPages.value > 0
                && !isImplicitDefaultPageLabels(
                    deps.pageLabelRanges.value,
                    deps.totalPages.value,
                )
                ? buildPageLabelsFromRanges(
                    deps.totalPages.value,
                    deps.pageLabelRanges.value,
                )
                : null;
            syncDirtyFlags(snapshot);
        } finally {
            isApplyingSnapshot.value = false;
        }
    }

    function resetToCurrentState() {
        const snapshot = captureCurrentSnapshot();
        history.value = [snapshot];
        historyIndex.value = 0;
        cleanSnapshot.value = cloneSnapshot(snapshot);
        metadataHistoryResetVersion.value += 1;
        syncDirtyFlags(snapshot);
    }

    function markCurrentStateClean() {
        const snapshot = captureCurrentSnapshot();
        cleanSnapshot.value = cloneSnapshot(snapshot);
        syncDirtyFlags(snapshot);
    }

    function preserveCurrentStateForNextSourceReload() {
        preservedReloadSnapshot.value = captureCurrentSnapshot();
    }

    function clearPreservedSourceReloadState() {
        preservedReloadSnapshot.value = null;
    }

    function consumePreservedSourceReloadState() {
        const snapshot = preservedReloadSnapshot.value;
        preservedReloadSnapshot.value = null;
        if (!snapshot) {
            return false;
        }

        applySnapshot(snapshot);
        return true;
    }

    function recordCurrentState() {
        if (isApplyingSnapshot.value) {
            return;
        }

        const snapshot = captureCurrentSnapshot();
        const current = history.value[historyIndex.value] ?? null;
        if (!current) {
            history.value = [snapshot];
            historyIndex.value = 0;
            cleanSnapshot.value ??= cloneSnapshot(snapshot);
            syncDirtyFlags(snapshot);
            return;
        }

        if (isEqual(snapshot, current)) {
            syncDirtyFlags(snapshot);
            return;
        }

        const nextHistory = [
            ...history.value.slice(0, historyIndex.value + 1),
            snapshot,
        ];
        if (nextHistory.length > maxWorkspaceMetadataHistoryEntries) {
            const baseline = nextHistory[0];
            const trailing = nextHistory.slice(
                -(maxWorkspaceMetadataHistoryEntries - 1),
            );
            history.value = baseline
                ? [
                    baseline,
                    ...trailing,
                ]
                : trailing;
        } else {
            history.value = nextHistory;
        }
        historyIndex.value = history.value.length - 1;
        metadataHistoryMutationVersion.value += 1;
        syncDirtyFlags(snapshot);
    }

    const canUndoMetadata = computed(() => historyIndex.value > 0);
    const canRedoMetadata = computed(
        () => historyIndex.value >= 0 && historyIndex.value < history.value.length - 1,
    );

    function undoMetadata() {
        if (!canUndoMetadata.value) {
            return false;
        }

        historyIndex.value -= 1;
        const snapshot = history.value[historyIndex.value];
        if (!snapshot) {
            return false;
        }

        applySnapshot(snapshot);
        return true;
    }

    function redoMetadata() {
        if (!canRedoMetadata.value) {
            return false;
        }

        historyIndex.value += 1;
        const snapshot = history.value[historyIndex.value];
        if (!snapshot) {
            return false;
        }

        applySnapshot(snapshot);
        return true;
    }

    return {
        canUndoMetadata,
        canRedoMetadata,
        metadataHistoryMutationVersion,
        metadataHistoryResetVersion,
        resetToCurrentState,
        markCurrentStateClean,
        clearPreservedSourceReloadState,
        consumePreservedSourceReloadState,
        preserveCurrentStateForNextSourceReload,
        recordCurrentState,
        undoMetadata,
        redoMetadata,
    };
};
