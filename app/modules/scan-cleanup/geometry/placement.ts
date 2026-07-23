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
    left: number;
    top: number;
}

export function resolvePreviewMetadataPlacement(
    metadata: IScanCleanupPreviewMetadata,
    alignment?: TScanCleanupPageAlignment,
): IScanCleanupPreviewPlacement {
    const offset = alignment === undefined
        ? {
            x: metadata.placementOffsetXPx,
            y: metadata.placementOffsetYPx,
        }
        : resolveScanCleanupPlacementOffset(
            metadata.canvasWidthPx - metadata.outputWidthPx,
            metadata.canvasHeightPx - metadata.outputHeightPx,
            alignment,
        );
    return {
        canvasWidthPx: metadata.canvasWidthPx,
        canvasHeightPx: metadata.canvasHeightPx,
        left: offset.x,
        top: offset.y,
    };
}

export function toPreviewStyleRect(
    rect: IScanCleanupPixelRect,
    placement: IScanCleanupPreviewPlacement,
): CSSProperties {
    return {
        left: `${(rect.xPx + placement.left) / placement.canvasWidthPx * 100}%`,
        top: `${(rect.yPx + placement.top) / placement.canvasHeightPx * 100}%`,
        width: `${rect.widthPx / placement.canvasWidthPx * 100}%`,
        height: `${rect.heightPx / placement.canvasHeightPx * 100}%`,
    };
}
