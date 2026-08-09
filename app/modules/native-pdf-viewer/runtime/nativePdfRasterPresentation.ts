import type { TDocumentViewportVisualOwner } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

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

export function shouldInvalidateNativePdfRaster(options: {
    status: 'idle' | 'loading' | 'loaded' | 'error';
    hasObjectUrl: boolean;
    requestedIdentity: INativePdfRasterIdentity | null | undefined;
    committedIdentity: INativePdfRasterIdentity | null | undefined;
    targetIdentity: INativePdfRasterIdentity;
}) {
    return (
        options.status === 'loading'
        && !nativePdfRasterIdentityMatches(options.requestedIdentity, options.targetIdentity)
    ) || (
        options.hasObjectUrl
        && !nativePdfRasterIdentityMatches(options.committedIdentity, options.targetIdentity)
    );
}

export function shouldPresentNativePdfPageSkeleton(options: {
    residentVisualInvalidated?: boolean;
    visual: TDocumentViewportVisualOwner | null | undefined;
    pageNumber: number;
    surfaceReady: boolean;
    visualCommitted: boolean;
}) {
    return !options.visualCommitted && (
        options.residentVisualInvalidated === true
        || options.surfaceReady
            && options.visual?.kind === 'page'
            && options.visual.pageNumber === options.pageNumber
            && options.visual.presentation === 'skeleton'
    );
}
