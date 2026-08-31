import type {
    InjectionKey,
    Ref,
} from 'vue';
import { useEventListener } from '@vueuse/core';
import type { ICropSelectionResult } from '@app/types/crop';
import type {
    IClientPoint,
    IClientRect,
    ILocalRect,
    IOverlayRect,
} from '@app/utils/document-viewer/region-geometry/regionGeometryTypes';
import { getRectHeight } from '@app/utils/document-viewer/region-geometry/getRectHeight';
import { getRectWidth } from '@app/utils/document-viewer/region-geometry/getRectWidth';
import { toClientRect } from '@app/utils/document-viewer/region-geometry/toClientRect';
import { toLocalRect } from '@app/utils/document-viewer/region-geometry/toLocalRect';
import type { ISnipPointerPayload } from '@app/modules/pdf-viewer/engine/pdf-region-drag/snipPointerPayload';
import { createSelectionPointerDragHandlers } from '@app/modules/pdf-viewer/engine/pdf-region-drag/createSelectionPointerDragHandlers';
import { createSelectionRectFromPointerDrag } from '@app/modules/pdf-viewer/engine/pdf-region-drag/createSelectionRectFromPointerDrag';
import {
    createKeyboardSelection as createKeyboardSelectionInBounds,
    updateKeyboardSelection as updateKeyboardSelectionInBounds,
} from '@app/utils/document-viewer/region-geometry/keyboardSelection';

type TCropSelectionState = 'idle' | 'selecting';

interface IUsePdfCropSelectionOptions {viewerContainer: Ref<HTMLElement | null>;}

interface IPageTarget {
    pageNumber: number;
    clientRect: IClientRect;
}

export interface IPdfCropSelectionKeyboardController {handleKeyboardKey: (event: KeyboardEvent) => boolean;}

export const pdfCropSelectionKeyboardKey: InjectionKey<IPdfCropSelectionKeyboardController> = Symbol(
    'pdf-crop-selection-keyboard',
);

const MIN_SELECTION_SIZE = 5;

export const usePdfCropSelection = (options: IUsePdfCropSelectionOptions) => {
    const state = ref<TCropSelectionState>('idle');
    const selectionRect = ref<ILocalRect | null>(null);
    const isSelecting = computed(() => state.value === 'selecting');

    let dragStartPoint: IClientPoint | null = null;
    let pendingResolver: ((result: ICropSelectionResult | null) => void) | null = null;
    const isEscapeCancelActive = ref(false);
    let activePageTarget: IPageTarget | null = null;
    let keyboardSelection: IClientRect | null = null;
    let keyboardOverlayRect: IOverlayRect | null = null;
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

    function findKeyboardPageTarget(): IPageTarget | null {
        const container = options.viewerContainer.value;
        if (!container) {
            return null;
        }

        const containerRect = toClientRect(container.getBoundingClientRect());
        let bestTarget: IPageTarget | null = null;
        let bestVisibleArea = 0;
        for (const el of container.querySelectorAll<HTMLElement>('.page_container[data-page]')) {
            const clientRect = toClientRect(el.getBoundingClientRect());
            const visibleWidth = Math.max(
                0,
                Math.min(clientRect.right, containerRect.right) - Math.max(clientRect.left, containerRect.left),
            );
            const visibleHeight = Math.max(
                0,
                Math.min(clientRect.bottom, containerRect.bottom) - Math.max(clientRect.top, containerRect.top),
            );
            const visibleArea = visibleWidth * visibleHeight;
            if (visibleArea > bestVisibleArea) {
                bestTarget = toPageTarget(el, clientRect);
                bestVisibleArea = visibleArea;
            }
            if (!bestTarget && getRectWidth(clientRect) > 0 && getRectHeight(clientRect) > 0) {
                bestTarget = toPageTarget(el, clientRect);
            }
        }
        return bestTarget;
    }

    function getOverlayRect(): IOverlayRect | null {
        const container = options.viewerContainer.value;
        if (!container) {
            return null;
        }
        const rect = toClientRect(container.getBoundingClientRect());
        return {
            left: rect.left,
            top: rect.top,
            width: getRectWidth(rect),
            height: getRectHeight(rect),
        };
    }

    function createKeyboardSelection(pageTarget: IPageTarget, overlayRect: IOverlayRect) {
        const selection = createKeyboardSelectionInBounds(pageTarget.clientRect, MIN_SELECTION_SIZE);
        keyboardSelection = selection;
        keyboardOverlayRect = overlayRect;
        selectionRect.value = toLocalRect(selection, overlayRect);
        return selection;
    }

    function updateKeyboardSelection(event: KeyboardEvent) {
        const pageTarget = activePageTarget ?? findKeyboardPageTarget();
        const overlayRect = keyboardOverlayRect ?? getOverlayRect();
        if (!pageTarget || !overlayRect) {
            return null;
        }
        activePageTarget = pageTarget;
        let selection = keyboardSelection ?? createKeyboardSelection(pageTarget, overlayRect);
        selection = updateKeyboardSelectionInBounds(
            selection,
            pageTarget.clientRect,
            event,
            MIN_SELECTION_SIZE,
        );
        keyboardSelection = selection;
        keyboardOverlayRect = overlayRect;
        selectionRect.value = toLocalRect(selection, overlayRect);
        return selection;
    }

    function detachEscapeListener() {
        isEscapeCancelActive.value = false;
    }

    function resolveSession(result: ICropSelectionResult | null) {
        detachEscapeListener();
        dragStartPoint = null;
        activePageTarget = null;
        keyboardSelection = null;
        keyboardOverlayRect = null;
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

    function completeKeyboardSelection() {
        if (!keyboardSelection || !activePageTarget) {
            const pageTarget = activePageTarget ?? findKeyboardPageTarget();
            const overlayRect = keyboardOverlayRect ?? getOverlayRect();
            if (pageTarget && overlayRect) {
                activePageTarget = pageTarget;
                createKeyboardSelection(pageTarget, overlayRect);
            }
        }
        if (!keyboardSelection || !activePageTarget) {
            cancelSelection();
            return;
        }

        const pageLocalRect = toLocalRect(
            keyboardSelection,
            toOverlayRect(activePageTarget.clientRect),
        );
        if (pageLocalRect.width < MIN_SELECTION_SIZE || pageLocalRect.height < MIN_SELECTION_SIZE) {
            cancelSelection();
            return;
        }

        resolveSession({
            pageNumber: activePageTarget.pageNumber,
            pageRect: {
                width: getRectWidth(activePageTarget.clientRect),
                height: getRectHeight(activePageTarget.clientRect),
            },
            pageLocalRect,
        });
    }

    function handleKeyboardKey(event: KeyboardEvent) {
        if (state.value !== 'selecting') {
            return false;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            cancelSelection();
            return true;
        }
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            completeKeyboardSelection();
            return true;
        }
        if (![
            'ArrowLeft',
            'ArrowRight',
            'ArrowUp',
            'ArrowDown',
        ].includes(event.key)) {
            return false;
        }
        event.preventDefault();
        updateKeyboardSelection(event);
        return true;
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
        keyboardSelection = null;
        keyboardOverlayRect = null;
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

    provide(pdfCropSelectionKeyboardKey, {handleKeyboardKey});

    return {
        state,
        isSelecting,
        selectionRect,
        startCropSelection,
        onPointerStart: pointerDragHandlers.onPointerStart,
        onPointerMove: pointerDragHandlers.onPointerMove,
        onPointerEnd: pointerDragHandlers.onPointerEnd,
        cancelSelection,
        handleKeyboardKey,
    };
};
