export const DJVU_PREVIEW_HEADROOM = 1.5;
export const DJVU_PREVIEW_SUBSAMPLE_MAX = 12;

export interface IDjvuPreviewResolutionRequest {
    nativeWidth: number;
    neededDevicePx: number;
    headroom?: number;
    maxSubsample?: number;
}

export interface IDjvuPreviewResolutionPlan {
    targetPx: number;
    subsample: number;
}

function normalizePositiveInteger(value: number) {
    return Number.isFinite(value) && value > 0
        ? Math.max(1, Math.round(value))
        : 1;
}

export function resolveDjvuPreviewResolutionPlan(
    request: IDjvuPreviewResolutionRequest,
): IDjvuPreviewResolutionPlan {
    const nativeWidth = normalizePositiveInteger(request.nativeWidth);
    const neededDevicePx = normalizePositiveInteger(request.neededDevicePx);
    const headroom = typeof request.headroom === 'number'
        && Number.isFinite(request.headroom)
        && request.headroom > 0
        ? request.headroom
        : DJVU_PREVIEW_HEADROOM;
    const maxSubsample = typeof request.maxSubsample === 'number'
        && Number.isFinite(request.maxSubsample)
        && request.maxSubsample > 0
        ? Math.max(1, Math.trunc(request.maxSubsample))
        : DJVU_PREVIEW_SUBSAMPLE_MAX;
    const targetPx = Math.min(nativeWidth, Math.ceil(neededDevicePx * headroom));
    const subsample = Math.max(1, Math.min(maxSubsample, Math.floor(nativeWidth / targetPx)));

    return {
        targetPx,
        subsample,
    };
}
