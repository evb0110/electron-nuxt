import type {
    IScanCleanupPreviewMetadata,
    IScanCleanupPixelRect,
} from '@contracts/electronApiScanCleanup';
import type {CSSProperties} from 'vue';

export interface IScanCleanupPreviewPlacement {
    canvasWidthPx: number;
    canvasHeightPx: number;
    left: number;
    top: number;
}

export function resolvePreviewMetadataPlacement(metadata: IScanCleanupPreviewMetadata): IScanCleanupPreviewPlacement {
    return {
        canvasWidthPx: metadata.canvasWidthPx,
        canvasHeightPx: metadata.canvasHeightPx,
        left: metadata.placementOffsetXPx,
        top: metadata.placementOffsetYPx,
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
