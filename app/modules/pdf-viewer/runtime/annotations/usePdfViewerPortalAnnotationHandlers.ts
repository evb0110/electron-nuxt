import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import type { IAnnotationContextMenuPayload } from '@app/modules/pdf-viewer/engine/annotationContextMenuPayload';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/annotations/domain/annotationSummaryIdentity';

interface IUsePdfViewerPortalAnnotationHandlersOptions {
    activeCommentStableKey: { value: string | null };
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
        options.activeCommentStableKey.value = annotationIdForSummary(comment);
        options.emitAnnotationOpenNote(comment);
    }

    function handleMarkerContextMenu(comment: IAnnotationCommentSummary, event: MouseEvent) {
        prepareMarkerInteraction();
        options.activeCommentStableKey.value = annotationIdForSummary(comment);
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
