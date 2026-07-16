import { ZOOM } from '@app/constants/pdfLayout';
import { isMacClientPlatform } from '@app/utils/clientPlatform';
import { clampDocumentManualZoom } from '@app/utils/document-viewer/zoomPolicy';
import type { TZoomMode } from '@contracts/shared';

export const DOCUMENT_WHEEL_ZOOM_SENSITIVITY = 0.0016;
const WHEEL_LINE_DELTA_PX = 16;
const WHEEL_DELTA_LINE_MODE = 1;
const WHEEL_DELTA_PAGE_MODE = 2;

export type TDocumentWheelIntent = 'scroll' | 'platform-scroll' | 'zoom';

/**
 * The renderer-facing subset of the physical wheel event. Modifier keys and
 * deltaZ deliberately stay behind the shared intent resolver so consumers
 * cannot reclassify the gesture and recreate presentation-policy drift.
 */
export interface IDocumentWheelSourceEvent {
    readonly cancelable: boolean;
    readonly clientX: number;
    readonly clientY: number;
    readonly defaultPrevented: boolean;
    readonly deltaX: number;
    readonly deltaY: number;
    readonly timeStamp: number;
    preventDefault(): void;
}

export interface IDocumentWheelInteraction {
    readonly deltaPx: number;
    readonly event: IDocumentWheelSourceEvent;
    readonly intent: TDocumentWheelIntent;
}

interface IDocumentWheelZoomTarget {
    cumulativeDelta: number;
    nextEffectiveZoom: number;
    nextZoom: number;
    valid: true;
    zoomFactor: number;
}

interface IDocumentWheelZoomInvalidTarget {
    cumulativeDelta: number;
    reason?: 'below-manual-min-zoom-out';
    valid: false;
    zoomFactor: number;
}

interface IDocumentWheelZoomSink {
    effectiveZoom: number;
    emitZoom: (value: number) => void;
    emitZoomMode: (mode: TZoomMode) => void;
    zoomMode: TZoomMode;
}

interface IReadonlyValue<TValue> {readonly value: TValue;}

interface IDocumentWheelZoomEmit {
    (event: 'update:zoom', value: number): void;
    (event: 'update:zoomMode', value: TZoomMode): void;
}

function normalizeWheelDelta(value: number, deltaMode: number, viewport: HTMLElement) {
    if (deltaMode === WHEEL_DELTA_LINE_MODE) {
        return value * WHEEL_LINE_DELTA_PX;
    }
    if (deltaMode === WHEEL_DELTA_PAGE_MODE) {
        return value * Math.max(viewport.clientHeight, 1);
    }
    return value;
}

function resolveWheelDeltaPx(event: WheelEvent, viewport: HTMLElement) {
    const primaryDelta = normalizeWheelDelta(event.deltaY, event.deltaMode, viewport);
    if (Math.abs(primaryDelta) >= Number.EPSILON || Math.abs(event.deltaZ) <= Number.EPSILON) {
        return primaryDelta;
    }
    return normalizeWheelDelta(event.deltaZ, event.deltaMode, viewport);
}

export function resolveDocumentWheelIntent(event: WheelEvent, isMac = isMacClientPlatform()): TDocumentWheelIntent {
    if (isMac && event.ctrlKey && !event.metaKey) {
        return 'platform-scroll';
    }
    if (event.ctrlKey || event.metaKey || Math.abs(event.deltaZ) > Number.EPSILON) {
        return 'zoom';
    }
    return 'scroll';
}

export function resolveDocumentWheelInteraction(
    event: WheelEvent,
    viewport: HTMLElement,
    isMac = isMacClientPlatform(),
): IDocumentWheelInteraction {
    return {
        deltaPx: resolveWheelDeltaPx(event, viewport),
        event,
        intent: resolveDocumentWheelIntent(event, isMac),
    };
}

export function resolveDocumentWheelCumulativeDelta(startZoom: number, targetZoom: number) {
    if (
        !Number.isFinite(startZoom)
        || startZoom <= 0
        || !Number.isFinite(targetZoom)
        || targetZoom <= 0
    ) {
        return null;
    }

    return -Math.log(targetZoom / startZoom) / DOCUMENT_WHEEL_ZOOM_SENSITIVITY;
}

export function resolveDocumentWheelZoomTarget(
    startZoom: number,
    cumulativeDelta: number,
    deltaPx: number,
): IDocumentWheelZoomTarget | IDocumentWheelZoomInvalidTarget {
    let nextCumulativeDelta = cumulativeDelta + deltaPx;
    let zoomFactor = Math.exp(-nextCumulativeDelta * DOCUMENT_WHEEL_ZOOM_SENSITIVITY);
    if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
        return {
            cumulativeDelta: nextCumulativeDelta,
            valid: false,
            zoomFactor,
        };
    }

    const rawNextEffectiveZoom = startZoom * zoomFactor;
    if (startZoom < ZOOM.MIN && rawNextEffectiveZoom <= startZoom) {
        return {
            cumulativeDelta: 0,
            reason: 'below-manual-min-zoom-out',
            valid: false,
            zoomFactor: 1,
        };
    }

    const nextEffectiveZoom = clampDocumentManualZoom(rawNextEffectiveZoom);
    if (Math.abs(rawNextEffectiveZoom - nextEffectiveZoom) >= 0.001) {
        const clampedCumulativeDelta = resolveDocumentWheelCumulativeDelta(startZoom, nextEffectiveZoom);
        if (clampedCumulativeDelta !== null) {
            nextCumulativeDelta = clampedCumulativeDelta;
            zoomFactor = nextEffectiveZoom / startZoom;
        }
    }

    return {
        cumulativeDelta: nextCumulativeDelta,
        nextEffectiveZoom,
        nextZoom: nextEffectiveZoom,
        valid: true,
        zoomFactor,
    };
}

export function consumeDocumentWheelZoomInteraction(
    interaction: IDocumentWheelInteraction,
    sink: IDocumentWheelZoomSink,
) {
    if (interaction.intent !== 'zoom') {
        return false;
    }

    interaction.event.preventDefault();
    const target = resolveDocumentWheelZoomTarget(sink.effectiveZoom, 0, interaction.deltaPx);
    if (!target.valid) {
        return true;
    }
    if (sink.zoomMode !== 'custom') {
        sink.emitZoomMode('custom');
    }
    sink.emitZoom(target.nextZoom);
    return true;
}

export function createDocumentWheelZoomHandler(
    effectiveZoom: IReadonlyValue<number>,
    zoomMode: IReadonlyValue<TZoomMode>,
    emit: IDocumentWheelZoomEmit,
) {
    return (interaction: IDocumentWheelInteraction) => consumeDocumentWheelZoomInteraction(interaction, {
        effectiveZoom: effectiveZoom.value,
        zoomMode: zoomMode.value,
        emitZoomMode: mode => emit('update:zoomMode', mode),
        emitZoom: value => emit('update:zoom', value),
    });
}
