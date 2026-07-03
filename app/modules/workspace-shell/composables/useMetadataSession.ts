import type {
    Ref,
    ShallowRef,
} from 'vue';
import {
    useBookmarkState,
    usePageLabelState,
} from '@app/modules/pdf-viewer/public';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import { useWorkspaceMetadataHistory } from '@app/modules/workspace-shell/composables/useWorkspaceMetadataHistory';
import { useWorkspaceUndoTimeline } from '@app/modules/workspace-shell/composables/useWorkspaceUndoTimeline';

interface IMetadataSessionOptions {
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    totalPages: Ref<number>;
    markDirty: () => void;
    fileHistoryMutationVersion: Readonly<Ref<number>>;
    fileHistorySessionVersion: Readonly<Ref<number>>;
    annotationHistoryMutationVersion?: Readonly<Ref<number>> | undefined;
    annotationHistoryResetVersion?: Readonly<Ref<number>> | undefined;
    undoFile: () => Promise<boolean>;
    redoFile: () => Promise<boolean>;
    undoAnnotation?: (() => Promise<boolean> | boolean) | undefined;
    redoAnnotation?: (() => Promise<boolean> | boolean) | undefined;
}

export const useMetadataSession = (options: IMetadataSessionOptions) => {
    const {
        pdfDocument,
        totalPages,
        markDirty,
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        annotationHistoryMutationVersion,
        annotationHistoryResetVersion,
        undoFile,
        redoFile,
        undoAnnotation,
        redoAnnotation,
    } = options;

    let metadataHistory: ReturnType<typeof useWorkspaceMetadataHistory> | null = null;

    const pageLabelState = usePageLabelState({
        pdfDocument,
        totalPages,
        markDirty,
        onPageLabelsSynchronized: () => metadataHistory?.resetToCurrentState(),
        onPageLabelsDirty: () => metadataHistory?.recordCurrentState(),
        onPageLabelsSaved: () => metadataHistory?.markCurrentStateClean(),
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
        onBookmarksSaved: () => metadataHistory?.markCurrentStateClean(),
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
        annotationHistoryMutationVersion,
        annotationHistoryResetVersion,
        undoFile,
        redoFile,
        undoMetadata: () => metadataHistory?.undoMetadata() ?? false,
        redoMetadata: () => metadataHistory?.redoMetadata() ?? false,
        undoAnnotation,
        redoAnnotation,
    });

    return {
        pageLabelState,
        bookmarkState,
        metadataHistory,
        clearPreservedSourceReloadMetadata: () => metadataHistory?.clearPreservedSourceReloadState(),
        consumePreservedSourceReloadMetadata: () => metadataHistory?.consumePreservedSourceReloadState() ?? false,
        preserveMetadataForNextSourceReload: () => metadataHistory?.preserveCurrentStateForNextSourceReload(),
        workspaceUndoTimeline,
    };
};
