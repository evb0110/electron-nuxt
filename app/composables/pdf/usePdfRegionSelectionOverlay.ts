import type { CSSProperties } from 'vue';
import type {
    ILocalRect,
    ISnipPointerPayload,
} from '@app/composables/pdf/usePdfRegionSnip';

interface IRegionSelectionOverlayOptions {
    isActive: () => boolean;
    onPointerStart: (payload: ISnipPointerPayload) => void;
    onPointerMove: (payload: ISnipPointerPayload) => void;
    onPointerEnd: (payload: ISnipPointerPayload) => void;
    onCancel: () => void;
}

export interface IRegionSelectionOverlayBaseProps {
    active: boolean;
    selectionRect: ILocalRect | null;
    hintLabel: string;
}

export interface IRegionSelectionOverlayEmits {
    (e: 'pointer-start', payload: ISnipPointerPayload): void;
    (e: 'pointer-move', payload: ISnipPointerPayload): void;
    (e: 'pointer-end', payload: ISnipPointerPayload): void;
    (e: 'cancel'): void;
}

function buildPointerPayload(event: PointerEvent): ISnipPointerPayload | null {
    const target = event.currentTarget as HTMLElement | null;
    if (!target) {
        return null;
    }

    const rect = target.getBoundingClientRect();
    return {
        clientX: event.clientX,
        clientY: event.clientY,
        overlayRect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
        },
    };
}

export function regionRectStyle(rect: ILocalRect | null): CSSProperties {
    if (!rect) {
        return {};
    }
    return {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
    };
}

export function usePdfRegionSelectionOverlay(options: IRegionSelectionOverlayOptions) {
    function handlePointerDown(event: PointerEvent) {
        if (!options.isActive() || event.button !== 0) {
            return;
        }

        (event.currentTarget as HTMLElement | null)?.setPointerCapture(event.pointerId);
        const payload = buildPointerPayload(event);
        if (payload) {
            options.onPointerStart(payload);
        }
    }

    function handlePointerMove(event: PointerEvent) {
        if (!options.isActive()) {
            return;
        }
        const payload = buildPointerPayload(event);
        if (payload) {
            options.onPointerMove(payload);
        }
    }

    function handlePointerUp(event: PointerEvent) {
        if (!options.isActive() || event.button !== 0) {
            return;
        }
        const payload = buildPointerPayload(event);
        if (payload) {
            options.onPointerEnd(payload);
        }
    }

    function handleContextMenu(event: MouseEvent) {
        if (!options.isActive()) {
            return;
        }
        event.preventDefault();
        options.onCancel();
    }

    function handleWheel(event: WheelEvent) {
        if (!options.isActive()) {
            return;
        }
        event.preventDefault();
    }

    return {
        handlePointerDown,
        handlePointerMove,
        handlePointerUp,
        handleContextMenu,
        handleWheel,
    };
}

export function useEmittedPdfRegionSelectionOverlay(
    props: IRegionSelectionOverlayBaseProps,
    emit: IRegionSelectionOverlayEmits,
) {
    return usePdfRegionSelectionOverlay({
        isActive: () => props.active,
        onPointerStart: payload => emit('pointer-start', payload),
        onPointerMove: payload => emit('pointer-move', payload),
        onPointerEnd: payload => emit('pointer-end', payload),
        onCancel: () => emit('cancel'),
    });
}
