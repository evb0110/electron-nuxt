import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import type { IAnnotationContextMenuPayload } from '@app/modules/pdf-viewer/engine/annotationContextMenuPayload';

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
    ) => void;
    getAnnotationTool?: (() => string) | undefined;
    cancelAnnotationTool?: (() => void) | undefined;
    isCommentPlacementActive?: (() => boolean) | undefined;
    cancelCommentPlacement?: (() => void) | undefined;
}

export const usePdfViewerPortalAnnotationHandlers = (options: IUsePdfViewerPortalAnnotationHandlersOptions) => {
    function removeAnnotationFromDom(comment: IAnnotationCommentSummary) {
        if (comment.annotationId) {
            options.suppressAnnotationId(comment.annotationId);
        }
        options.removeAnnotationFromDom(comment);
        options.refreshHiddenAnnotationPage(comment);
    }

    function prepareMarkerInteraction() {
        const annotationTool = options.getAnnotationTool?.();
        if (annotationTool && annotationTool !== 'none') {
            options.cancelAnnotationTool?.();
        }
        if (options.isCommentPlacementActive?.() === true) {
            options.cancelCommentPlacement?.();
        }
    }

    function handleMarkerOpenNote(comment: IAnnotationCommentSummary) {
        prepareMarkerInteraction();
        options.activeCommentStableKey.value = comment.stableKey;
        options.emitAnnotationOpenNote(comment);
    }

    function handleMarkerContextMenu(comment: IAnnotationCommentSummary, event: MouseEvent) {
        prepareMarkerInteraction();
        options.activeCommentStableKey.value = comment.stableKey;
        options.emitAnnotationContextMenu(options.buildAnnotationContextMenuPayload(
            comment,
            event.clientX,
            event.clientY,
        ));
    }

    function handleMarkerMove(comment: IAnnotationCommentSummary, markerRect: IAnnotationMarkerRect) {
        options.handleMarkerMove(comment, markerRect);
    }

    return {
        removeAnnotationFromDom,
        handleMarkerOpenNote,
        handleMarkerContextMenu,
        handleMarkerMove,
    };
};
