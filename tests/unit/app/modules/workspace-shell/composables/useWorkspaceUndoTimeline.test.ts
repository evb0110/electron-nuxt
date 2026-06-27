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
    const annotationHistoryMutationVersion = ref(0);
    const annotationHistoryResetVersion = ref(0);
    const undoFile = vi.fn(async () => true);
    const redoFile = vi.fn(async () => true);
    const undoMetadata = vi.fn(async () => true);
    const redoMetadata = vi.fn(async () => true);
    const undoAnnotation = vi.fn(async () => true);
    const redoAnnotation = vi.fn(async () => true);

    return {
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        metadataHistoryMutationVersion,
        metadataHistoryResetVersion,
        annotationHistoryMutationVersion,
        annotationHistoryResetVersion,
        undoFile,
        redoFile,
        undoMetadata,
        redoMetadata,
        undoAnnotation,
        redoAnnotation,
        timeline: useWorkspaceUndoTimeline({
            fileHistoryMutationVersion,
            fileHistorySessionVersion,
            metadataHistoryMutationVersion,
            metadataHistoryResetVersion,
            annotationHistoryMutationVersion,
            annotationHistoryResetVersion,
            undoFile,
            redoFile,
            undoMetadata,
            redoMetadata,
            undoAnnotation,
            redoAnnotation,
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

    it('preserves mutation order across file, metadata, and annotation histories', async () => {
        const {
            fileHistoryMutationVersion,
            metadataHistoryMutationVersion,
            annotationHistoryMutationVersion,
            undoFile,
            undoMetadata,
            undoAnnotation,
            redoMetadata,
            redoAnnotation,
            redoFile,
            timeline,
        } = createTimeline();

        fileHistoryMutationVersion.value += 1;
        annotationHistoryMutationVersion.value += 1;
        metadataHistoryMutationVersion.value += 1;

        expect(timeline.nextUndoSource.value).toBe('metadata');

        await timeline.undoTimeline();
        await timeline.undoTimeline();
        await timeline.undoTimeline();

        expect(undoMetadata).toHaveBeenCalledOnce();
        expect(undoAnnotation).toHaveBeenCalledOnce();
        expect(undoFile).toHaveBeenCalledOnce();
        expect(timeline.canUndoTimeline.value).toBe(false);

        await timeline.redoTimeline();
        await timeline.redoTimeline();
        await timeline.redoTimeline();

        expect(redoFile).toHaveBeenCalledOnce();
        expect(redoAnnotation).toHaveBeenCalledOnce();
        expect(redoMetadata).toHaveBeenCalledOnce();
        expect(timeline.canRedoTimeline.value).toBe(false);
    });

    it('does not move the cursor when an annotation undo fails', async () => {
        const {
            annotationHistoryMutationVersion,
            undoAnnotation,
            timeline,
        } = createTimeline();
        undoAnnotation.mockResolvedValue(false);

        annotationHistoryMutationVersion.value += 1;

        expect(await timeline.undoTimeline()).toBe(false);
        expect(timeline.nextUndoSource.value).toBe('annotation');
        expect(timeline.canUndoTimeline.value).toBe(true);
    });

    it('drops annotation entries when the annotation baseline resets', async () => {
        const {
            annotationHistoryMutationVersion,
            annotationHistoryResetVersion,
            fileHistoryMutationVersion,
            undoFile,
            timeline,
        } = createTimeline();

        annotationHistoryMutationVersion.value += 1;
        fileHistoryMutationVersion.value += 1;
        annotationHistoryResetVersion.value += 1;

        expect(timeline.nextUndoSource.value).toBe('file');

        await timeline.undoTimeline();
        expect(undoFile).toHaveBeenCalledOnce();
        expect(timeline.canUndoTimeline.value).toBe(false);
    });

    it('ignores annotation mutation version drops from remounted viewer exposes', () => {
        const {
            annotationHistoryMutationVersion,
            timeline,
        } = createTimeline();

        annotationHistoryMutationVersion.value = 3;
        expect(timeline.nextUndoSource.value).toBe('annotation');

        annotationHistoryMutationVersion.value = 0;
        expect(timeline.nextUndoSource.value).toBe('annotation');

        annotationHistoryMutationVersion.value = 1;
        expect(timeline.nextUndoSource.value).toBe('annotation');
    });

    it('ignores annotation reset version drops from remounted viewer exposes', () => {
        const {
            annotationHistoryMutationVersion,
            annotationHistoryResetVersion,
            timeline,
        } = createTimeline();

        annotationHistoryMutationVersion.value = 3;
        annotationHistoryResetVersion.value = 2;
        expect(timeline.canUndoTimeline.value).toBe(false);

        annotationHistoryMutationVersion.value = 4;
        expect(timeline.nextUndoSource.value).toBe('annotation');

        annotationHistoryResetVersion.value = 0;
        expect(timeline.nextUndoSource.value).toBe('annotation');
    });
});
