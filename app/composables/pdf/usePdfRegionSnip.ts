import type { Ref } from 'vue';
import {
    useEventListener,
    useTimeoutFn,
} from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browserLogger';
import { clamp } from 'es-toolkit/math';
import type {
    IClientPoint,
    IClientRect,
    ILocalRect,
    IOverlayRect,
} from '@app/utils/pdf-viewer/pdf-region-geometry/pdfRegionGeometryTypes';
import { getRectHeight } from '@app/utils/pdf-viewer/pdf-region-geometry/getRectHeight';
import { getRectWidth } from '@app/utils/pdf-viewer/pdf-region-geometry/getRectWidth';
import { toLocalRect } from '@app/utils/pdf-viewer/pdf-region-geometry/toLocalRect';
import type { ISnipPointerPayload } from '@app/utils/pdf-viewer/pdf-region-drag/pdfRegionDragTypes';
import { createSelectionPointerDragHandlers } from '@app/utils/pdf-viewer/pdf-region-drag/createSelectionPointerDragHandlers';
import { createSelectionRectFromPointerDrag } from '@app/utils/pdf-viewer/pdf-region-drag/createSelectionRectFromPointerDrag';
import { capturePdfRegionAsPngBlob } from '@app/utils/pdf-viewer/pdf-region-capture/capturePdfRegionAsPngBlob';
import { writePngBlobToClipboard } from '@app/utils/pdf-viewer/pdf-region-clipboard/writePngBlobToClipboard';

type TSnipState = 'idle' | 'selecting' | 'copying' | 'success' | 'error';

interface IUsePdfRegionSnipOptions {viewerContainer: Ref<HTMLElement | null>;}

interface IBadgePosition {
    x: number;
    y: number;
}

export const usePdfRegionSnip = (options: IUsePdfRegionSnipOptions) => {
    const state = ref<TSnipState>('idle');
    const selectionRect = ref<ILocalRect | null>(null);
    const flashRect = ref<ILocalRect | null>(null);
    const badgePosition = ref<IBadgePosition | null>(null);

    const isActive = computed(() => state.value === 'selecting' || state.value === 'copying');

    let dragStartPoint: IClientPoint | null = null;
    let pendingResolver: ((result: boolean) => void) | null = null;
    const isEscapeCancelActive = ref(false);
    const escapeKeyTarget = computed(() => (
        isEscapeCancelActive.value && typeof window !== 'undefined'
            ? window
            : null
    ));
    const {
        start: startSuccessTimer,
        stop: stopSuccessTimer,
    } = useTimeoutFn(() => {
        resetOverlayVisuals();
        resolveSession(true);
    }, 850, { immediate: false });

    function clearSuccessTimer() {
        stopSuccessTimer();
    }

    function detachEscapeListener() {
        isEscapeCancelActive.value = false;
    }

    function resolveSession(result: boolean) {
        detachEscapeListener();
        dragStartPoint = null;
        state.value = 'idle';

        const resolver = pendingResolver;
        pendingResolver = null;
        resolver?.(result);
    }

    function resetOverlayVisuals() {
        selectionRect.value = null;
        flashRect.value = null;
        badgePosition.value = null;
    }

    function cancelCapture() {
        if (state.value === 'idle') {
            return;
        }

        clearSuccessTimer();
        resetOverlayVisuals();
        resolveSession(false);
    }

    function abortPendingSession() {
        if (!pendingResolver) {
            return;
        }
        clearSuccessTimer();
        resetOverlayVisuals();
        resolveSession(false);
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
        cancelCapture();
    }

    useEventListener(escapeKeyTarget, 'keydown', handleEscapeKey, { capture: true });

    function updateSelectionFromPointer(
        payload: ISnipPointerPayload,
        startPoint: IClientPoint,
    ) {
        const selection = createSelectionRectFromPointerDrag(payload, startPoint);
        selectionRect.value = selection.localRect;
        return selection.clientRect;
    }

    function setSuccessVisuals(outputRect: IClientRect, overlayRect: IOverlayRect) {
        const localRect = toLocalRect(outputRect, overlayRect);
        const badgeHeight = 28;
        const margin = 8;

        flashRect.value = localRect;
        badgePosition.value = {
            x: clamp(localRect.x + localRect.width / 2, margin, Math.max(margin, overlayRect.width - margin)),
            y: clamp(localRect.y + localRect.height + margin, margin, Math.max(margin, overlayRect.height - badgeHeight - margin)),
        };
    }

    async function completeSelection(payload: ISnipPointerPayload) {
        const viewerContainer = options.viewerContainer.value;
        if (!dragStartPoint || !viewerContainer) {
            cancelCapture();
            return;
        }

        const selection = updateSelectionFromPointer(payload, dragStartPoint);
        const selectionWidth = getRectWidth(selection);
        const selectionHeight = getRectHeight(selection);
        if (selectionWidth < 2 || selectionHeight < 2) {
            cancelCapture();
            return;
        }

        state.value = 'copying';
        try {
            const capture = await capturePdfRegionAsPngBlob(viewerContainer, selection);
            if (!capture) {
                cancelCapture();
                return;
            }

            await writePngBlobToClipboard(capture.blob);

            selectionRect.value = null;
            state.value = 'success';
            setSuccessVisuals(capture.outputRect, payload.overlayRect);

            clearSuccessTimer();
            startSuccessTimer();
        } catch (error) {
            BrowserLogger.debug('pdf-snip', 'Failed to copy selected PDF region', error);
            state.value = 'error';
            resetOverlayVisuals();
            resolveSession(false);
        }
    }

    const pointerDragHandlers = createSelectionPointerDragHandlers({
        getState: () => state.value,
        getStartPoint: () => dragStartPoint,
        setStartPoint: (point) => {
            dragStartPoint = point;
        },
        updateSelection: updateSelectionFromPointer,
        onEnd: (payload) => {
            void completeSelection(payload);
        },
    });

    function startCaptureSession() {
        if (!options.viewerContainer.value) {
            return Promise.resolve(false);
        }
        // Starting a new session must settle any previous awaiter to avoid
        // retaining stale resolvers across quick repeated captures.
        abortPendingSession();
        if (state.value === 'selecting') {
            cancelCapture();
            return Promise.resolve(false);
        }
        if (state.value === 'copying') {
            return Promise.resolve(false);
        }

        clearSuccessTimer();
        resetOverlayVisuals();
        dragStartPoint = null;
        state.value = 'selecting';
        attachEscapeCancel();

        return new Promise<boolean>((resolve) => {
            pendingResolver = resolve;
        });
    }

    onUnmounted(() => {
        abortPendingSession();
        clearSuccessTimer();
        detachEscapeListener();
    });

    return {
        state,
        isActive,
        selectionRect,
        flashRect,
        badgePosition,
        startCaptureSession,
        onPointerStart: pointerDragHandlers.onPointerStart,
        onPointerMove: pointerDragHandlers.onPointerMove,
        onPointerEnd: pointerDragHandlers.onPointerEnd,
        cancelCapture,
    };
};
