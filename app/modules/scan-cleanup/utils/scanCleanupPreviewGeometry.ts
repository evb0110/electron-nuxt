import type {
    IScanCleanupPreviewPageMetadata,
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

export interface IScanCleanupPreviewFitPlacement {
    height: number;
    left: number;
    top: number;
    width: number;
}

export interface IScanCleanupPreviewFitArea extends IScanCleanupPreviewSize {
    left: number;
    top: number;
}

export interface IScanCleanupPreviewSize {
    height: number;
    width: number;
}

export interface IScanCleanupCutterControlGeometry {
    controlLeft: number;
    handleCenter: number;
    lineCenter: number;
}

export function scanCleanupAnalysisWidth(
    metadata: Pick<IScanCleanupPreviewPageMetadata, 'rotation'>,
    rawWidth: number,
    rawHeight: number,
) {
    return metadata.rotation === 90 || metadata.rotation === 270 ? rawHeight : rawWidth;
}

export function scanCleanupCutterRatio(cutterX: number, analysisWidth: number) {
    return Math.min(0.98, Math.max(0.02, cutterX / Math.max(1, analysisWidth)));
}

export function scanCleanupCutterXFromRatio(ratio: number, analysisWidth: number) {
    return Math.min(0.98, Math.max(0.02, ratio)) * Math.max(1, analysisWidth);
}

export function resolvePreviewFitPlacement(
    containerWidth: number,
    containerHeight: number,
    contentWidth: number,
    contentHeight: number,
): IScanCleanupPreviewFitPlacement {
    const scale = Math.min(
        containerWidth / Math.max(1, contentWidth),
        containerHeight / Math.max(1, contentHeight),
    );
    const width = Math.max(0, contentWidth * scale);
    const height = Math.max(0, contentHeight * scale);
    return {
        width,
        height,
        left: Math.max(0, containerWidth - width) / 2,
        top: Math.max(0, containerHeight - height) / 2,
    };
}

export function resolvePreviewOutputFitSizes(
    availableAreas: IScanCleanupPreviewSize[],
    canvases: IScanCleanupPreviewSize[],
): IScanCleanupPreviewSize[] {
    if (availableAreas.length !== canvases.length || canvases.length === 0) {
        return [];
    }
    const scale = Math.max(0, Math.min(...canvases.map((canvas, index) => {
        const available = availableAreas[index] ?? {
            width: 0,
            height: 0,
        };
        return Math.min(
            available.width / Math.max(1, canvas.width),
            available.height / Math.max(1, canvas.height),
        );
    })));
    return canvases.map(canvas => ({
        width: canvas.width * scale,
        height: canvas.height * scale,
    }));
}

export function resolvePreviewOutputFitRects(
    availableAreas: IScanCleanupPreviewFitArea[],
    canvases: IScanCleanupPreviewSize[],
): IScanCleanupPreviewFitPlacement[] {
    const sizes = resolvePreviewOutputFitSizes(availableAreas, canvases);
    return sizes.map((size, index) => {
        const available = availableAreas[index]!;
        return {
            ...size,
            left: available.left + Math.max(0, available.width - size.width) / 2,
            top: available.top + Math.max(0, available.height - size.height) / 2,
        };
    });
}

export function resolvePreviewSpreadCutterCenter(
    renderedBoxes: readonly IScanCleanupPreviewFitPlacement[],
) {
    if (renderedBoxes.length < 2) {
        return null;
    }
    const [
        left,
        right,
    ] = [...renderedBoxes].sort((first, second) => first.left - second.left);
    return ((left?.left ?? 0) + (left?.width ?? 0) + (right?.left ?? 0)) / 2;
}

export function resolveCutterControlGeometry(
    center: number,
    controlWidth: number,
    lineWidth: number,
): IScanCleanupCutterControlGeometry {
    const controlLeft = center - controlWidth / 2;
    return {
        controlLeft,
        handleCenter: controlLeft + controlWidth / 2,
        lineCenter: controlLeft + (controlWidth - lineWidth) / 2 + lineWidth / 2,
    };
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

function invertAffineMatrix(matrix: number[][]) {
    const a = matrix[0]?.[0] ?? 1;
    const b = matrix[0]?.[1] ?? 0;
    const c = matrix[0]?.[2] ?? 0;
    const d = matrix[1]?.[0] ?? 0;
    const e = matrix[1]?.[1] ?? 1;
    const f = matrix[1]?.[2] ?? 0;
    const determinant = a * e - b * d;
    if (Math.abs(determinant) < Number.EPSILON) {
        return null;
    }
    return [
        [
            e / determinant,
            -b / determinant,
            (b * f - e * c) / determinant,
        ],
        [
            -d / determinant,
            a / determinant,
            (d * c - a * f) / determinant,
        ],
        [
            0,
            0,
            1,
        ],
    ];
}

export function clampPreviewRect(rect: IScanCleanupPreviewRect, width: number, height: number): IScanCleanupPreviewRect {
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
    return transformPreviewSourceHalfRect(metadata, metadata.contentBox);
}

export function transformPreviewSourceHalfRect(
    metadata: IScanCleanupPreviewMetadata,
    rect: IScanCleanupPreviewRect | null | undefined,
) {
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
    return clampPreviewRect({
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
    }, metadata.outputWidth, metadata.outputHeight);
}

export function previewPointToSourceHalf(
    metadata: IScanCleanupPreviewMetadata,
    point: {
        x: number;
        y: number
    },
) {
    const matrix = metadata.forwardTransform?.matrix;
    const inverse = matrix ? invertAffineMatrix(matrix) : null;
    if (!inverse) {
        return null;
    }
    const source = applyMatrix(inverse, point.x, point.y);
    return {
        x: source.x - metadata.sourceRegion.x,
        y: source.y - metadata.sourceRegion.y,
    };
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
