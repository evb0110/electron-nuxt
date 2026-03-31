import type { ComputedRef } from 'vue';

interface IUsePdfViewerMouseInteractionsOptions {
    isSnipActive: () => boolean;
    isViewerPanDragModeActive: ComputedRef<boolean>;
    cancelPendingSearchScroll: () => void;
    handleDragStart: (event: MouseEvent) => void;
    handleDragMove: (event: MouseEvent) => void;
    stopDrag: () => void;
    handleViewerMouseUpAnnotation: () => void;
    handleViewerClickAnnotation: (event: MouseEvent) => void | Promise<void>;
    handleViewerDblClickAnnotation: (event: MouseEvent) => void;
    handleViewerContextMenuAnnotation: (event: MouseEvent) => void;
}

const COMMENT_TARGET_SELECTOR = [
    '.pdf-inline-comment-anchor-marker',
    '.pdf-inline-comment-marker',
    '.pdf-comment-marker-button',
    '.pdf-annotation-has-note-target',
    '.pdf-annotation-has-comment',
    '.annotationLayer .popupTriggerArea',
    '.annotation-layer .popupTriggerArea',
].join(', ');

function isImagePlacementTarget(target: EventTarget | null) {
    return target instanceof HTMLElement && Boolean(target.closest('.pdf-image-placement'));
}

function isCommentTarget(target: EventTarget | null) {
    return target instanceof HTMLElement && Boolean(target.closest(COMMENT_TARGET_SELECTOR));
}

export function usePdfViewerMouseInteractions(options: IUsePdfViewerMouseInteractionsOptions) {
    const {
        isSnipActive,
        isViewerPanDragModeActive,
        cancelPendingSearchScroll,
        handleDragStart,
        handleDragMove,
        stopDrag,
        handleViewerMouseUpAnnotation,
        handleViewerClickAnnotation,
        handleViewerDblClickAnnotation,
        handleViewerContextMenuAnnotation,
    } = options;

    function handleViewerMouseDown(event: MouseEvent) {
        if (isSnipActive() || isImagePlacementTarget(event.target)) {
            return;
        }
        if (isCommentTarget(event.target)) {
            event.preventDefault();
            return;
        }
        cancelPendingSearchScroll();
        handleDragStart(event);
    }

    function handleViewerMouseMove(event: MouseEvent) {
        if (isSnipActive() || isImagePlacementTarget(event.target)) {
            return;
        }
        handleDragMove(event);
    }

    function handleViewerMouseUp(event: MouseEvent) {
        if (isSnipActive() || isImagePlacementTarget(event.target)) {
            return;
        }
        handleViewerMouseUpAnnotation();
    }

    function handleViewerMouseLeave() {
        if (isSnipActive()) {
            return;
        }
        stopDrag();
    }

    function handleSelectStart(event: Event) {
        if (isViewerPanDragModeActive.value) {
            event.preventDefault();
        }
    }

    function handleViewerClick(event: MouseEvent) {
        if (isSnipActive() || isImagePlacementTarget(event.target)) {
            return;
        }
        void handleViewerClickAnnotation(event);
    }

    function handleViewerDblClick(event: MouseEvent) {
        if (isSnipActive() || isImagePlacementTarget(event.target)) {
            return;
        }
        handleViewerDblClickAnnotation(event);
    }

    function handleViewerContextMenu(event: MouseEvent) {
        event.preventDefault();
        if (isSnipActive() || isImagePlacementTarget(event.target)) {
            return;
        }
        handleViewerContextMenuAnnotation(event);
    }

    return {
        handleViewerMouseDown,
        handleViewerMouseMove,
        handleViewerMouseUp,
        handleViewerMouseLeave,
        handleSelectStart,
        handleViewerClick,
        handleViewerDblClick,
        handleViewerContextMenu,
    };
}
