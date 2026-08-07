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
    const matchedCanvas = metadata.matchedCanvasContentWidthPx != null
        || metadata.matchedCanvasContentHeightPx != null;
    if (!matchedCanvas) {
        return resolveScanCleanupPlacementOffset(
            metadata.canvasWidthPx - contentWidthPx,
            metadata.canvasHeightPx - contentHeightPx,
            alignment,
        );
    }

    // Matched-canvas margins are hard insets around the same inner rectangle
    // used by the main-process preview and final PDF assembler. Live alignment
    // changes therefore align inside that rectangle, not against the outer
    // canvas edge; otherwise top/left alignment visually erases the margin.
    const margins = metadata.appliedMargins;
    const innerWidthPx = Math.max(0,
        metadata.canvasWidthPx - margins.leftPx - margins.rightPx);
    const innerHeightPx = Math.max(0,
        metadata.canvasHeightPx - margins.topPx - margins.bottomPx);
    const innerOffset = resolveScanCleanupPlacementOffset(
        Math.max(0, innerWidthPx - contentWidthPx),
        Math.max(0, innerHeightPx - contentHeightPx),
        alignment,
    );
    return {
        x: margins.leftPx + innerOffset.x,
        y: margins.topPx + innerOffset.y,
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
