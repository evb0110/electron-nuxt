import { clamp } from 'es-toolkit/math';
import { ZOOM } from '@app/constants/pdfLayout';
import type {
    TFitMode,
    TZoomMode,
} from '@app/types/pdf';

interface IZoomLimits {
    manualMin: number;
    manualMax: number;
    fitMin: number;
    fitMax: number;
}

interface IResolvePdfZoomScaleInput {
    zoomMode: TZoomMode;
    fitMode: TFitMode;
    manualZoom: number;
    fitScale: number;
    limits?: Partial<IZoomLimits>;
}

function normalizePositiveNumber(value: number, fallback: number) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeFiniteNumber(value: number, fallback: number) {
    return Number.isFinite(value) ? value : fallback;
}

function resolveZoomLimits(limits?: Partial<IZoomLimits>): IZoomLimits {
    return {
        manualMin: normalizePositiveNumber(limits?.manualMin ?? ZOOM.MIN, ZOOM.MIN),
        manualMax: normalizePositiveNumber(limits?.manualMax ?? ZOOM.MAX, ZOOM.MAX),
        fitMin: normalizePositiveNumber(limits?.fitMin ?? ZOOM.FIT_MIN, ZOOM.FIT_MIN),
        fitMax: normalizePositiveNumber(limits?.fitMax ?? ZOOM.MAX, ZOOM.MAX),
    };
}

function normalizeFitIntent(zoomMode: TZoomMode, fitMode: TFitMode) {
    if (zoomMode === 'fit-height') {
        return 'height';
    }
    if (zoomMode === 'fit-width') {
        return 'width';
    }
    return fitMode;
}

export function clampPdfManualZoom(level: number, limits?: Partial<IZoomLimits>) {
    const resolvedLimits = resolveZoomLimits(limits);
    return clamp(
        normalizeFiniteNumber(level, 1),
        resolvedLimits.manualMin,
        resolvedLimits.manualMax,
    );
}

export function clampPdfFitScale(level: number, limits?: Partial<IZoomLimits>) {
    const resolvedLimits = resolveZoomLimits(limits);
    return clamp(
        normalizeFiniteNumber(level, 1),
        resolvedLimits.fitMin,
        resolvedLimits.fitMax,
    );
}

export function resolvePdfZoomScale(input: IResolvePdfZoomScaleInput) {
    if (input.zoomMode === 'custom') {
        return {
            mode: 'custom' as const,
            fitMode: normalizeFitIntent(input.zoomMode, input.fitMode),
            effectiveScale: clampPdfManualZoom(input.manualZoom, input.limits),
        };
    }

    return {
        mode: input.zoomMode,
        fitMode: normalizeFitIntent(input.zoomMode, input.fitMode),
        effectiveScale: clampPdfFitScale(input.fitScale, input.limits),
    };
}
