import { PDF_NATIVE_PAGE_PREVIEW_RASTER_WIDTH_CEILING_PX } from '@contracts/electronApiDocuments';

export interface INativePdfRasterIdentity {
    generation: number;
    pageNumber: number;
    pageWidth: number;
    pageHeight: number;
    targetWidthPx: number;
}

export function createNativePdfRasterIdentity(options: INativePdfRasterIdentity): INativePdfRasterIdentity {
    return {
        generation: Math.trunc(options.generation),
        pageNumber: Math.max(1, Math.trunc(options.pageNumber)),
        pageWidth: Math.max(1, Math.round(options.pageWidth)),
        pageHeight: Math.max(1, Math.round(options.pageHeight)),
        targetWidthPx: Math.max(1, Math.round(options.targetWidthPx)),
    };
}

export function withNativePdfRasterTargetWidth(
    identity: INativePdfRasterIdentity,
    targetWidthPx: number,
) {
    return createNativePdfRasterIdentity({
        ...identity,
        targetWidthPx,
    });
}

export function resolveNativePdfRasterTargetWidth(
    neededWidthPx: number,
    rasterWidthCeilingPx: number | null | undefined,
) {
    const normalizedNeededWidth = Math.max(1, Math.ceil(neededWidthPx));
    if (
        rasterWidthCeilingPx === null
        || rasterWidthCeilingPx === undefined
        || !Number.isFinite(rasterWidthCeilingPx)
        || rasterWidthCeilingPx < 1
    ) {
        return normalizedNeededWidth;
    }
    return Math.min(normalizedNeededWidth, Math.max(1, Math.trunc(rasterWidthCeilingPx)));
}

export function nativePdfRasterOutputCoversRequest(
    renderedPx: number,
    requestedPx: number,
    rasterWidthCeilingPx: number | null | undefined,
) {
    const expectedPx = resolveNativePdfRasterTargetWidth(requestedPx, rasterWidthCeilingPx);
    return isTrustedNativePdfRasterWidthCeiling(rasterWidthCeilingPx)
        && Number.isFinite(renderedPx)
        && renderedPx >= expectedPx;
}

export function isTrustedNativePdfRasterWidthCeiling(value: number | null | undefined) {
    return value === undefined || value === PDF_NATIVE_PAGE_PREVIEW_RASTER_WIDTH_CEILING_PX;
}

export function nativePdfRasterIdentityMatches(
    left: INativePdfRasterIdentity | null | undefined,
    right: INativePdfRasterIdentity | null | undefined,
) {
    return Boolean(
        left
        && right
        && left.generation === right.generation
        && left.pageNumber === right.pageNumber
        && left.pageWidth === right.pageWidth
        && left.pageHeight === right.pageHeight
        && left.targetWidthPx === right.targetWidthPx,
    );
}

export function nativePdfRasterIdentityCovers(
    available: INativePdfRasterIdentity | null | undefined,
    required: INativePdfRasterIdentity | null | undefined,
) {
    return Boolean(
        available
        && required
        && available.generation === required.generation
        && available.pageNumber === required.pageNumber
        && available.pageWidth === required.pageWidth
        && available.pageHeight === required.pageHeight
        && available.targetWidthPx >= required.targetWidthPx,
    );
}

export function shouldInvalidateNativePdfRaster(options: {
    status: 'idle' | 'loading' | 'loaded' | 'error';
    hasObjectUrl: boolean;
    requestedIdentity: INativePdfRasterIdentity | null | undefined;
    committedIdentity: INativePdfRasterIdentity | null | undefined;
    targetIdentity: INativePdfRasterIdentity;
}) {
    return (
        options.status === 'loading'
        && !nativePdfRasterIdentityCovers(options.requestedIdentity, options.targetIdentity)
    ) || (
        options.hasObjectUrl
        && !nativePdfRasterIdentityCovers(options.committedIdentity, options.targetIdentity)
    );
}

export function shouldPresentNativePdfPageSkeleton(options: {
    residentVisualInvalidated?: boolean;
    surfaceReady: boolean;
    visualCommitted: boolean;
}) {
    return !options.visualCommitted && (
        options.residentVisualInvalidated === true
        || options.surfaceReady
    );
}
