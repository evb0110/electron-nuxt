import type {
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewRect,
    TScanCleanupPageAlignment,
} from '@contracts/electronApiScanCleanup';
import type {CSSProperties} from 'vue';

export interface IScanCleanupPreviewPlacement {
    canvasWidth: number;
    canvasHeight: number;
    left: number;
    top: number;
}

function alignmentFactor(alignment: TScanCleanupPageAlignment) {
    const [
        vertical,
        horizontal = vertical,
    ] = alignment.split('-');
    return {
        x: horizontal === 'left' ? 0 : horizontal === 'right' ? 1 : 0.5,
        y: vertical === 'top' ? 0 : vertical === 'bottom' ? 1 : 0.5,
    };
}

export function resolvePreviewPlacement(
    outputWidth: number,
    outputHeight: number,
    canvasWidth: number,
    canvasHeight: number,
    alignment: TScanCleanupPageAlignment,
): IScanCleanupPreviewPlacement {
    const factor = alignmentFactor(alignment);
    return {
        canvasWidth,
        canvasHeight,
        left: Math.max(0, canvasWidth - outputWidth) * factor.x,
        top: Math.max(0, canvasHeight - outputHeight) * factor.y,
    };
}

export function resolvePreviewCanvasSize(
    outputs: IScanCleanupPreviewMetadata[],
    matchPageSize: boolean,
) {
    if (!matchPageSize || outputs.length === 0) {
        return null;
    }
    return {
        width: Math.max(...outputs.map(output => output.outputWidth)),
        height: Math.max(...outputs.map(output => output.outputHeight)),
    };
}

function applyMatrix(matrix: number[][], x: number, y: number) {
    const denominator = (matrix[2]?.[0] ?? 0) * x + (matrix[2]?.[1] ?? 0) * y + (matrix[2]?.[2] ?? 1);
    return {
        x: ((matrix[0]?.[0] ?? 1) * x + (matrix[0]?.[1] ?? 0) * y + (matrix[0]?.[2] ?? 0)) / denominator,
        y: ((matrix[1]?.[0] ?? 0) * x + (matrix[1]?.[1] ?? 1) * y + (matrix[1]?.[2] ?? 0)) / denominator,
    };
}

function clampRect(rect: IScanCleanupPreviewRect, width: number, height: number): IScanCleanupPreviewRect {
    const left = Math.max(0, Math.min(width, rect.x));
    const top = Math.max(0, Math.min(height, rect.y));
    const right = Math.max(left, Math.min(width, rect.x + rect.width));
    const bottom = Math.max(top, Math.min(height, rect.y + rect.height));
    return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    };
}

export function transformPreviewContentBox(metadata: IScanCleanupPreviewMetadata) {
    const rect = metadata.contentBox;
    const matrix = metadata.forwardTransform?.matrix;
    if (!rect || !matrix || matrix.length !== 3) {
        return null;
    }
    // Content detection runs inside the selected half, while the exported affine
    // maps coordinates from the full source page into the cleaned output.
    const x = rect.x + metadata.sourceRegion.x;
    const y = rect.y + metadata.sourceRegion.y;
    const corners = [
        applyMatrix(matrix, x, y),
        applyMatrix(matrix, x + rect.width, y),
        applyMatrix(matrix, x, y + rect.height),
        applyMatrix(matrix, x + rect.width, y + rect.height),
    ];
    const xs = corners.map(point => point.x);
    const ys = corners.map(point => point.y);
    return clampRect({
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
    }, metadata.outputWidth, metadata.outputHeight);
}

export function toPreviewStyleRect(
    rect: IScanCleanupPreviewRect,
    placement: IScanCleanupPreviewPlacement,
): CSSProperties {
    return {
        left: `${(rect.x + placement.left) / placement.canvasWidth * 100}%`,
        top: `${(rect.y + placement.top) / placement.canvasHeight * 100}%`,
        width: `${rect.width / placement.canvasWidth * 100}%`,
        height: `${rect.height / placement.canvasHeight * 100}%`,
    };
}
