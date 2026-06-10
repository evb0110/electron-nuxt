import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import type { IAnnotationContextMenuPayload } from '@app/utils/pdf-viewer/annotationContextMenuPayload';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { syncCommentMarkerAnchorEditor } from '@app/utils/pdf-viewer/pdf-annotation-editor-utils/commentMarkerAnchorEditor';

interface IUsePdfViewerPortalAnnotationHandlersOptions {
    activeCommentStableKey: { value: string | null };
    suppressAnnotationId: (annotationId: string) => void;
    removeAnnotationFromDom: (comment: IAnnotationCommentSummary) => void;
    refreshHiddenAnnotationPage: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationContextMenu: (payload: IAnnotationContextMenuPayload) => void;
    buildAnnotationContextMenuPayload: (
        comment: IAnnotationCommentSummary,
        clientX: number,
        clientY: number,
    ) => IAnnotationContextMenuPayload;
    handleMarkerMove: (
        comment: IAnnotationCommentSummary,
        markerRect: IAnnotationMarkerRect,
        options: {
            markEditorPending: (
                updated: IAnnotationCommentSummary,
                original: IAnnotationCommentSummary,
                pendingMarkerRect: IAnnotationMarkerRect,
            ) => void;
            markModified: () => void;
        },
    ) => void;
    findEditorForComment: (comment: IAnnotationCommentSummary) => IPdfjsEditor | null;
    addPendingCommentEditorKey: (key: string) => void;
    getEditorPendingKey: (editor: IPdfjsEditor, pageIndex: number) => string;
    markModified: () => void;
}

export function usePdfViewerPortalAnnotationHandlers(options: IUsePdfViewerPortalAnnotationHandlersOptions) {
    function removeAnnotationFromDom(comment: IAnnotationCommentSummary) {
        if (comment.annotationId) {
            options.suppressAnnotationId(comment.annotationId);
        }
        options.removeAnnotationFromDom(comment);
        options.refreshHiddenAnnotationPage(comment);
    }

    function handleMarkerOpenNote(comment: IAnnotationCommentSummary) {
        options.activeCommentStableKey.value = comment.stableKey;
        options.emitAnnotationOpenNote(comment);
    }

    function handleMarkerContextMenu(comment: IAnnotationCommentSummary, event: MouseEvent) {
        options.activeCommentStableKey.value = comment.stableKey;
        options.emitAnnotationContextMenu(options.buildAnnotationContextMenuPayload(
            comment,
            event.clientX,
            event.clientY,
        ));
    }

    function handleMarkerMove(comment: IAnnotationCommentSummary, markerRect: IAnnotationMarkerRect) {
        options.handleMarkerMove(comment, markerRect, {
            markEditorPending: (updated, original, pendingMarkerRect) => {
                const editor = options.findEditorForComment(updated) ?? options.findEditorForComment(original);
                if (!editor) {
                    return;
                }
                syncCommentMarkerAnchorEditor(editor, pendingMarkerRect);
                options.addPendingCommentEditorKey(
                    options.getEditorPendingKey(editor, updated.pageIndex),
                );
            },
            markModified: options.markModified,
        });
    }

    return {
        removeAnnotationFromDom,
        handleMarkerOpenNote,
        handleMarkerContextMenu,
        handleMarkerMove,
    };
}
