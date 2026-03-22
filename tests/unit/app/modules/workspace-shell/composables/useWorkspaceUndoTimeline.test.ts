import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { useWorkspaceUndoTimeline } from '@app/modules/workspace-shell/composables/useWorkspaceUndoTimeline';

function createTimeline() {
    const fileHistoryMutationVersion = ref(0);
    const fileHistorySessionVersion = ref(0);
    const metadataHistoryMutationVersion = ref(0);
    const metadataHistoryResetVersion = ref(0);
    const undoFile = vi.fn(async () => true);
    const redoFile = vi.fn(async () => true);
    const undoMetadata = vi.fn(async () => true);
    const redoMetadata = vi.fn(async () => true);

    return {
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        metadataHistoryMutationVersion,
        metadataHistoryResetVersion,
        undoFile,
        redoFile,
        undoMetadata,
        redoMetadata,
        timeline: useWorkspaceUndoTimeline({
            fileHistoryMutationVersion,
            fileHistorySessionVersion,
            metadataHistoryMutationVersion,
            metadataHistoryResetVersion,
            undoFile,
            redoFile,
            undoMetadata,
            redoMetadata,
        }),
    };
}

describe('useWorkspaceUndoTimeline', () => {
    it('preserves mutation order across file and metadata histories', async () => {
        const {
            fileHistoryMutationVersion,
            metadataHistoryMutationVersion,
            undoFile,
            undoMetadata,
            redoMetadata,
            redoFile,
            timeline,
        } = createTimeline();

        metadataHistoryMutationVersion.value += 1;
        fileHistoryMutationVersion.value += 1;

        expect(timeline.canUndoTimeline.value).toBe(true);
        expect(timeline.nextUndoSource.value).toBe('file');

        await timeline.undoTimeline();
        expect(undoFile).toHaveBeenCalledOnce();
        expect(timeline.nextUndoSource.value).toBe('metadata');

        await timeline.undoTimeline();
        expect(undoMetadata).toHaveBeenCalledOnce();
        expect(timeline.canUndoTimeline.value).toBe(false);

        await timeline.redoTimeline();
        await timeline.redoTimeline();
        expect(timeline.canRedoTimeline.value).toBe(false);
        expect(redoMetadata).toHaveBeenCalledOnce();
        expect(redoFile).toHaveBeenCalledOnce();
    });

    it('drops metadata entries when the metadata baseline resets', async () => {
        const {
            metadataHistoryMutationVersion,
            metadataHistoryResetVersion,
            fileHistoryMutationVersion,
            undoFile,
            timeline,
        } = createTimeline();

        metadataHistoryMutationVersion.value += 1;
        fileHistoryMutationVersion.value += 1;
        metadataHistoryResetVersion.value += 1;

        expect(timeline.nextUndoSource.value).toBe('file');

        await timeline.undoTimeline();
        expect(undoFile).toHaveBeenCalledOnce();
        expect(timeline.canUndoTimeline.value).toBe(false);
    });

    it('clears the combined timeline when a new file session starts', () => {
        const {
            fileHistoryMutationVersion,
            fileHistorySessionVersion,
            timeline,
        } = createTimeline();

        fileHistoryMutationVersion.value += 1;
        expect(timeline.canUndoTimeline.value).toBe(true);

        fileHistorySessionVersion.value += 1;
        expect(timeline.canUndoTimeline.value).toBe(false);
        expect(timeline.canRedoTimeline.value).toBe(false);
    });
});
