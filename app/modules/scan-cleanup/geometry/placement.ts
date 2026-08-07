import type {
    IScanCleanupPreviewMetadata,
    IScanCleanupPixelRect,
    TScanCleanupPageAlignment,
} from '@contracts/electronApiScanCleanup';
import {resolveScanCleanupPlacementOffset} from '@contracts/scanCleanupPageOverrides';
import type {CSSProperties} from 'vue';

export interface IScanCleanupPreviewPlacement {
    canvasWidthPx: number;
    canvasHeightPx: number;
    /** Size the intrinsic raster takes on the canvas, after normalization. */
    contentWidthPx: number;
    contentHeightPx: number;
    left: number;
    top: number;
    /**
     * Intrinsic raster pixels to canvas pixels, per axis. The two are the same
     * ratio — the content box keeps the raster's aspect — but the main process
     * rounds each side of that box to a whole canvas pixel independently, so a
     * single number cannot land on both. Measuring each axis from the side it
     * belongs to keeps a rect drawn over the page on the pixels it names,
     * instead of a pixel of drift down the page; nothing is distorted, because
     * the difference between the two is that rounding alone.
     */
    scaleX: number;
    scaleY: number;
}

/**
 * Where a cleaned raster sits on the page it was normalized onto. A matched
 * document scales every page to one visual size, and a preview keeps the raster
 * it rendered, so the placement carries the scale the presentation applies —
 * one number that every rect drawn over the page goes through.
 */
export function resolvePreviewMetadataPlacement(
    metadata: IScanCleanupPreviewMetadata,
    alignment?: TScanCleanupPageAlignment,
): IScanCleanupPreviewPlacement {
    const contentWidthPx = metadata.matchedCanvasContentWidthPx ?? metadata.outputWidthPx;
    const contentHeightPx = metadata.matchedCanvasContentHeightPx ?? metadata.outputHeightPx;
    const offset = alignment === undefined
        ? {
            x: metadata.placementOffsetXPx,
            y: metadata.placementOffsetYPx,
        }
        : resolveAlignedPreviewPlacement(
            metadata,
            contentWidthPx,
            contentHeightPx,
            alignment,
        );
    return {
        canvasWidthPx: metadata.canvasWidthPx,
        canvasHeightPx: metadata.canvasHeightPx,
        contentWidthPx,
        contentHeightPx,
        left: offset.x,
        top: offset.y,
        scaleX: contentWidthPx / Math.max(1, metadata.outputWidthPx),
        scaleY: contentHeightPx / Math.max(1, metadata.outputHeightPx),
    };
}

function resolveAlignedPreviewPlacement(
    metadata: IScanCleanupPreviewMetadata,
    contentWidthPx: number,
    contentHeightPx: number,
    alignment: TScanCleanupPageAlignment,
) {
    const reference = resolvePreviewAlignmentReferenceRect(
        metadata,
        contentWidthPx,
        contentHeightPx,
    );
    const offset = resolveScanCleanupPlacementOffset(
        reference.spanX,
        reference.spanY,
        alignment,
    );
    return {
        x: reference.originX + offset.x,
        y: reference.originY + offset.y,
    };
}

export function resolvePreviewAlignmentReferenceRect(
    metadata: IScanCleanupPreviewMetadata,
    contentWidthPx: number,
    contentHeightPx: number,
) {
    const matchedCanvas = metadata.matchedCanvasContentWidthPx != null
        || metadata.matchedCanvasContentHeightPx != null;
    const originX = matchedCanvas ? metadata.appliedMargins.leftPx : 0;
    const originY = matchedCanvas ? metadata.appliedMargins.topPx : 0;
    const horizontalInsets = matchedCanvas
        ? metadata.appliedMargins.leftPx + metadata.appliedMargins.rightPx
        : 0;
    const verticalInsets = matchedCanvas
        ? metadata.appliedMargins.topPx + metadata.appliedMargins.bottomPx
        : 0;
    return {
        originX,
        originY,
        spanX: Math.max(0, metadata.canvasWidthPx - horizontalInsets - contentWidthPx),
        spanY: Math.max(0, metadata.canvasHeightPx - verticalInsets - contentHeightPx),
    };
}

export function toPreviewStyleRect(
    rect: IScanCleanupPixelRect,
    placement: IScanCleanupPreviewPlacement,
): CSSProperties {
    return {
        left: `${(rect.xPx * placement.scaleX + placement.left) / placement.canvasWidthPx * 100}%`,
        top: `${(rect.yPx * placement.scaleY + placement.top) / placement.canvasHeightPx * 100}%`,
        width: `${rect.widthPx * placement.scaleX / placement.canvasWidthPx * 100}%`,
        height: `${rect.heightPx * placement.scaleY / placement.canvasHeightPx * 100}%`,
    };
}
