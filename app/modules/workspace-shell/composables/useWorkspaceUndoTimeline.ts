import type { Ref } from 'vue';
import type { TWorkspaceUndoSource } from '@app/types/workspaceUndoSource';

export const useWorkspaceUndoTimeline = (deps: {
    fileHistoryMutationVersion: Readonly<Ref<number>>;
    fileHistorySessionVersion: Readonly<Ref<number>>;
    metadataHistoryMutationVersion: Readonly<Ref<number>>;
    metadataHistoryResetVersion: Readonly<Ref<number>>;
    annotationHistoryMutationVersion?: Readonly<Ref<number>> | undefined;
    annotationHistoryResetVersion?: Readonly<Ref<number>> | undefined;
    undoFile: () => Promise<boolean>;
    redoFile: () => Promise<boolean>;
    undoMetadata: () => Promise<boolean> | boolean;
    redoMetadata: () => Promise<boolean> | boolean;
    undoAnnotation?: (() => Promise<boolean> | boolean) | undefined;
    redoAnnotation?: (() => Promise<boolean> | boolean) | undefined;
}) => {
    const entries = shallowRef<TWorkspaceUndoSource[]>([]);
    const entryIndex = ref(-1);

    function recordEntry(source: TWorkspaceUndoSource) {
        const nextEntries = entries.value.slice(0, entryIndex.value + 1);
        nextEntries.push(source);
        entries.value = nextEntries;
        entryIndex.value = nextEntries.length - 1;
    }

    function pruneEntries(source: TWorkspaceUndoSource) {
        if (entries.value.length === 0) {
            return;
        }

        let removedAppliedEntries = 0;
        const nextEntries = entries.value.filter((entry, index) => {
            const shouldRemove = entry === source;
            if (shouldRemove && index <= entryIndex.value) {
                removedAppliedEntries += 1;
            }
            return !shouldRemove;
        });

        entries.value = nextEntries;
        if (nextEntries.length === 0) {
            entryIndex.value = -1;
            return;
        }

        entryIndex.value = Math.min(
            nextEntries.length - 1,
            Math.max(-1, entryIndex.value - removedAppliedEntries),
        );
    }

    function resetTimeline() {
        entries.value = [];
        entryIndex.value = -1;
    }

    function didVersionIncrement(nextVersion: number, previousVersion: number | undefined) {
        return previousVersion !== undefined
            && nextVersion > previousVersion;
    }

    watch(
        deps.fileHistoryMutationVersion,
        (nextVersion, previousVersion) => {
            if (nextVersion === previousVersion) {
                return;
            }
            recordEntry('file');
        },
        { flush: 'sync' },
    );

    watch(
        deps.fileHistorySessionVersion,
        (nextVersion, previousVersion) => {
            if (nextVersion === previousVersion) {
                return;
            }
            resetTimeline();
        },
        { flush: 'sync' },
    );

    watch(
        deps.metadataHistoryMutationVersion,
        (nextVersion, previousVersion) => {
            if (nextVersion === previousVersion) {
                return;
            }
            recordEntry('metadata');
        },
        { flush: 'sync' },
    );

    watch(
        deps.metadataHistoryResetVersion,
        (nextVersion, previousVersion) => {
            if (nextVersion === previousVersion) {
                return;
            }
            pruneEntries('metadata');
        },
        { flush: 'sync' },
    );

    if (deps.annotationHistoryMutationVersion) {
        watch(
            deps.annotationHistoryMutationVersion,
            (nextVersion, previousVersion) => {
                if (!didVersionIncrement(nextVersion, previousVersion)) {
                    return;
                }
                recordEntry('annotation');
            },
            { flush: 'sync' },
        );
    }

    if (deps.annotationHistoryResetVersion) {
        watch(
            deps.annotationHistoryResetVersion,
            (nextVersion, previousVersion) => {
                if (!didVersionIncrement(nextVersion, previousVersion)) {
                    return;
                }
                pruneEntries('annotation');
            },
            { flush: 'sync' },
        );
    }

    const canUndoTimeline = computed(() => entryIndex.value >= 0);
    const canRedoTimeline = computed(
        () => entryIndex.value < entries.value.length - 1,
    );
    const nextUndoSource = computed<TWorkspaceUndoSource | null>(
        () => entries.value[entryIndex.value] ?? null,
    );
    const nextRedoSource = computed<TWorkspaceUndoSource | null>(
        () => entries.value[entryIndex.value + 1] ?? null,
    );

    async function undoTimeline() {
        const source = nextUndoSource.value;
        if (!source) {
            return false;
        }

        const didUndo = source === 'file'
            ? await deps.undoFile()
            : source === 'metadata'
                ? await deps.undoMetadata()
                : (await deps.undoAnnotation?.()) === true;
        if (!didUndo) {
            return false;
        }

        entryIndex.value -= 1;
        return true;
    }

    async function redoTimeline() {
        const source = nextRedoSource.value;
        if (!source) {
            return false;
        }

        const didRedo = source === 'file'
            ? await deps.redoFile()
            : source === 'metadata'
                ? await deps.redoMetadata()
                : (await deps.redoAnnotation?.()) === true;
        if (!didRedo) {
            return false;
        }

        entryIndex.value += 1;
        return true;
    }

    return {
        canUndoTimeline,
        canRedoTimeline,
        nextUndoSource,
        nextRedoSource,
        resetTimeline,
        undoTimeline,
        redoTimeline,
    };
};
