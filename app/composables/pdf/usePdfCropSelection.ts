import type { Ref } from 'vue';
import type { ICropSelectionResult } from '@app/types/crop';
import type {
    IClientRect,
    ILocalRect,
    IOverlayRect,
    ISnipPointerPayload,
} from '@app/composables/pdf/usePdfRegionSnip';
import {
    getRectHeight,
    getRectWidth,
    normalizeClientRect,
    toClientRect,
    toLocalRect,
} from '@app/composables/pdf/usePdfRegionSnip';

type TCropSelectionState = 'idle' | 'selecting';

interface IUsePdfCropSelectionOptions { viewerContainer: Ref<HTMLElement | null>; }

interface IPageTarget {
    pageNumber: number;
    clientRect: IClientRect;
}

const MIN_SELECTION_SIZE = 5;

export function usePdfCropSelection(options: IUsePdfCropSelectionOptions) {
    const state = ref<TCropSelectionState>('idle');
    const selectionRect = ref<ILocalRect | null>(null);
    const isSelecting = computed(() => state.value === 'selecting');

    let dragStartPoint: {
        clientX: number;
        clientY: number;
    } | null = null;
    let pendingResolver: ((result: ICropSelectionResult | null) => void) | null = null;
    let escapeKeyListener: ((event: KeyboardEvent) => void) | null = null;
    let activePageTarget: IPageTarget | null = null;

    function toOverlayRect(rect: IClientRect): IOverlayRect {
        return {
            left: rect.left,
            top: rect.top,
            width: getRectWidth(rect),
            height: getRectHeight(rect),
        };
    }

    function clampPointToRect(
        clientX: number,
        clientY: number,
        rect: IClientRect,
    ) {
        return {
            clientX: Math.max(rect.left, Math.min(rect.right, clientX)),
            clientY: Math.max(rect.top, Math.min(rect.bottom, clientY)),
        };
    }

    function findPageTargetAtPoint(clientX: number, clientY: number): IPageTarget | null {
        const container = options.viewerContainer.value;
        if (!container) {
            return null;
        }
        const pageContainers = container.querySelectorAll<HTMLElement>('.page_container[data-page]');
        for (const el of pageContainers) {
            const rect = toClientRect(el.getBoundingClientRect());
            if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
                const pageNum = parseInt(el.dataset.page ?? '', 10);
                return Number.isFinite(pageNum)
                    ? {
                        pageNumber: pageNum,
                        clientRect: rect,
                    }
                    : null;
            }
        }
        return null;
    }

    function detachEscapeListener() {
        if (typeof window !== 'undefined' && escapeKeyListener) {
            window.removeEventListener('keydown', escapeKeyListener, true);
        }
        escapeKeyListener = null;
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
        if (typeof window === 'undefined') {
            return;
        }

        detachEscapeListener();
        escapeKeyListener = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') {
                return;
            }
            event.preventDefault();
            cancelSelection();
        };
        window.addEventListener('keydown', escapeKeyListener, true);
    }

    function updateSelectionFromPointer(
        payload: ISnipPointerPayload,
        start: {
            clientX: number;
            clientY: number;
        },
    ) {
        if (!activePageTarget) {
            selectionRect.value = null;
            return null;
        }

        const clampedStart = clampPointToRect(start.clientX, start.clientY, activePageTarget.clientRect);
        const clampedEnd = clampPointToRect(payload.clientX, payload.clientY, activePageTarget.clientRect);
        const selection = normalizeClientRect(
            clampedStart.clientX,
            clampedStart.clientY,
            clampedEnd.clientX,
            clampedEnd.clientY,
        );
        selectionRect.value = toLocalRect(selection, payload.overlayRect);
        return selection;
    }

    function onPointerStart(payload: ISnipPointerPayload) {
        if (state.value !== 'selecting') {
            return;
        }

        const pageTarget = findPageTargetAtPoint(payload.clientX, payload.clientY);
        dragStartPoint = {
            clientX: payload.clientX,
            clientY: payload.clientY,
        };
        activePageTarget = pageTarget;
        updateSelectionFromPointer(payload, dragStartPoint);
    }

    function onPointerMove(payload: ISnipPointerPayload) {
        if (state.value !== 'selecting' || !dragStartPoint) {
            return;
        }
        updateSelectionFromPointer(payload, dragStartPoint);
    }

    function onPointerEnd(payload: ISnipPointerPayload) {
        if (state.value !== 'selecting' || !dragStartPoint) {
            return;
        }

        const selection = updateSelectionFromPointer(payload, dragStartPoint);
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
        onPointerStart,
        onPointerMove,
        onPointerEnd,
        cancelSelection,
    };
}
