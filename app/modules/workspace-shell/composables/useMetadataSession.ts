import type {
    Ref,
    ShallowRef,
} from 'vue';
import {
    useBookmarkState,
    usePageLabelState,
} from '@app/modules/pdf-viewer/public';
import type { PDFDocumentProxy } from '@app/types/pdf';
import { useWorkspaceMetadataHistory } from '@app/modules/workspace-shell/composables/useWorkspaceMetadataHistory';
import { useWorkspaceUndoTimeline } from '@app/modules/workspace-shell/composables/useWorkspaceUndoTimeline';

interface IMetadataSessionOptions {
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    totalPages: Ref<number>;
    markDirty: () => void;
    fileHistoryMutationVersion: Ref<number>;
    fileHistorySessionVersion: Ref<number>;
    undoFile: () => Promise<boolean>;
    redoFile: () => Promise<boolean>;
}

export const useMetadataSession = (options: IMetadataSessionOptions) => {
    const {
        pdfDocument,
        totalPages,
        markDirty,
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        undoFile,
        redoFile,
    } = options;

    let metadataHistory: ReturnType<typeof useWorkspaceMetadataHistory> | null = null;

    const pageLabelState = usePageLabelState({
        pdfDocument,
        totalPages,
        markDirty,
        onPageLabelsSynchronized: () => metadataHistory?.resetToCurrentState(),
        onPageLabelsDirty: () => metadataHistory?.recordCurrentState(),
        onPageLabelsSaved: () => metadataHistory?.resetToCurrentState(),
    });
    const {
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
    } = pageLabelState;

    const bookmarkState = useBookmarkState({
        markDirty,
        onBookmarksSynchronized: () => metadataHistory?.resetToCurrentState(),
        onBookmarksDirty: () => metadataHistory?.recordCurrentState(),
        onBookmarksSaved: () => metadataHistory?.resetToCurrentState(),
    });
    const {
        bookmarkItems,
        bookmarksDirty,
    } = bookmarkState;

    metadataHistory = useWorkspaceMetadataHistory({
        bookmarkItems,
        bookmarksDirty,
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        totalPages,
    });
    metadataHistory.resetToCurrentState();

    const workspaceUndoTimeline = useWorkspaceUndoTimeline({
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        metadataHistoryMutationVersion: metadataHistory.metadataHistoryMutationVersion,
        metadataHistoryResetVersion: metadataHistory.metadataHistoryResetVersion,
        undoFile,
        redoFile,
        undoMetadata: () => metadataHistory?.undoMetadata() ?? false,
        redoMetadata: () => metadataHistory?.redoMetadata() ?? false,
    });

    return {
        pageLabelState,
        bookmarkState,
        metadataHistory,
        workspaceUndoTimeline,
    };
};
