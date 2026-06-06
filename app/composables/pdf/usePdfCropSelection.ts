import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import type { ICropSelectionResult } from '@app/types/crop';
import type {
    IClientPoint,
    IClientRect,
    ILocalRect,
    IOverlayRect,
} from '@app/utils/pdf-viewer/pdf-region-geometry/pdfRegionGeometryTypes';
import { getRectHeight } from '@app/utils/pdf-viewer/pdf-region-geometry/getRectHeight';
import { getRectWidth } from '@app/utils/pdf-viewer/pdf-region-geometry/getRectWidth';
import { toClientRect } from '@app/utils/pdf-viewer/pdf-region-geometry/toClientRect';
import { toLocalRect } from '@app/utils/pdf-viewer/pdf-region-geometry/toLocalRect';
import type { ISnipPointerPayload } from '@app/utils/pdf-viewer/pdf-region-drag/snipPointerPayload';
import { createSelectionPointerDragHandlers } from '@app/utils/pdf-viewer/pdf-region-drag/createSelectionPointerDragHandlers';
import { createSelectionRectFromPointerDrag } from '@app/utils/pdf-viewer/pdf-region-drag/createSelectionRectFromPointerDrag';

type TCropSelectionState = 'idle' | 'selecting';

interface IUsePdfCropSelectionOptions { viewerContainer: Ref<HTMLElement | null>; }

interface IPageTarget {
    pageNumber: number;
    clientRect: IClientRect;
}

const MIN_SELECTION_SIZE = 5;

export const usePdfCropSelection = (options: IUsePdfCropSelectionOptions) => {
    const state = ref<TCropSelectionState>('idle');
    const selectionRect = ref<ILocalRect | null>(null);
    const isSelecting = computed(() => state.value === 'selecting');

    let dragStartPoint: IClientPoint | null = null;
    let pendingResolver: ((result: ICropSelectionResult | null) => void) | null = null;
    const isEscapeCancelActive = ref(false);
    let activePageTarget: IPageTarget | null = null;
    const escapeKeyTarget = computed(() => (
        isEscapeCancelActive.value && typeof window !== 'undefined'
            ? window
            : null
    ));

    function toOverlayRect(rect: IClientRect): IOverlayRect {
        return {
            left: rect.left,
            top: rect.top,
            width: getRectWidth(rect),
            height: getRectHeight(rect),
        };
    }

    function containsClientPoint(rect: IClientRect, clientX: number, clientY: number) {
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }

    function toPageTarget(element: HTMLElement, clientRect: IClientRect): IPageTarget | null {
        const pageNum = parseInt(element.dataset.page ?? '', 10);
        return Number.isFinite(pageNum)
            ? {
                pageNumber: pageNum,
                clientRect,
            }
            : null;
    }

    function findPageTargetAtPoint(clientX: number, clientY: number): IPageTarget | null {
        const container = options.viewerContainer.value;
        if (!container) {
            return null;
        }
        const pageContainers = container.querySelectorAll<HTMLElement>('.page_container[data-page]');
        for (const el of pageContainers) {
            const rect = toClientRect(el.getBoundingClientRect());
            if (containsClientPoint(rect, clientX, clientY)) {
                return toPageTarget(el, rect);
            }
        }
        return null;
    }

    function detachEscapeListener() {
        isEscapeCancelActive.value = false;
    }

    function resolveSession(result: ICropSelectionResult | null) {
        detachEscapeListener();
        dragStartPoint = null;
        activePageTarget = null;
        selectionRect.value = null;
        state.value = 'idle';

        const resolver = pendingResolver;
        pendingResolver = null;
        resolver?.(result);
    }

    function cancelSelection() {
        if (state.value === 'idle') {
            return;
        }
        resolveSession(null);
    }

    function abortPendingSession() {
        if (!pendingResolver) {
            return;
        }
        resolveSession(null);
    }

    function attachEscapeCancel() {
        detachEscapeListener();
        isEscapeCancelActive.value = true;
    }

    function handleEscapeKey(event: KeyboardEvent) {
        if (event.key !== 'Escape') {
            return;
        }
        event.preventDefault();
        cancelSelection();
    }

    useEventListener(escapeKeyTarget, 'keydown', handleEscapeKey, { capture: true });

    function updateSelectionFromPointer(
        payload: ISnipPointerPayload,
        start: IClientPoint,
    ) {
        if (!activePageTarget) {
            selectionRect.value = null;
            return null;
        }

        const selection = createSelectionRectFromPointerDrag(
            payload,
            start,
            activePageTarget.clientRect,
        );
        selectionRect.value = selection.localRect;
        return selection.clientRect;
    }

    function prepareSelectionStart(payload: ISnipPointerPayload) {
        const pageTarget = findPageTargetAtPoint(payload.clientX, payload.clientY);
        activePageTarget = pageTarget;
    }

    function completeSelection(
        payload: ISnipPointerPayload,
        startPoint: IClientPoint,
    ) {
        const selection = updateSelectionFromPointer(payload, startPoint);
        const pageTarget = activePageTarget;

        if (!selection || !pageTarget) {
            resolveSession(null);
            return;
        }

        const pageLocalRect = toLocalRect(selection, toOverlayRect(pageTarget.clientRect));
        if (pageLocalRect.width < MIN_SELECTION_SIZE || pageLocalRect.height < MIN_SELECTION_SIZE) {
            resolveSession(null);
            return;
        }

        resolveSession({
            pageNumber: pageTarget.pageNumber,
            pageRect: {
                width: getRectWidth(pageTarget.clientRect),
                height: getRectHeight(pageTarget.clientRect),
            },
            pageLocalRect,
        });
    }

    const pointerDragHandlers = createSelectionPointerDragHandlers({
        getState: () => state.value,
        getStartPoint: () => dragStartPoint,
        setStartPoint: (point) => {
            dragStartPoint = point;
        },
        updateSelection: updateSelectionFromPointer,
        onStart: prepareSelectionStart,
        onEnd: completeSelection,
    });

    function startCropSelection() {
        if (!options.viewerContainer.value) {
            return Promise.resolve(null);
        }

        abortPendingSession();
        if (state.value === 'selecting') {
            cancelSelection();
            return Promise.resolve(null);
        }

        selectionRect.value = null;
        dragStartPoint = null;
        activePageTarget = null;
        state.value = 'selecting';
        attachEscapeCancel();

        return new Promise<ICropSelectionResult | null>((resolve) => {
            pendingResolver = resolve;
        });
    }

    onUnmounted(() => {
        abortPendingSession();
        detachEscapeListener();
    });

    return {
        state,
        isSelecting,
        selectionRect,
        startCropSelection,
        onPointerStart: pointerDragHandlers.onPointerStart,
        onPointerMove: pointerDragHandlers.onPointerMove,
        onPointerEnd: pointerDragHandlers.onPointerEnd,
        cancelSelection,
    };
};
