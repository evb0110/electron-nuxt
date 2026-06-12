import type { IImagePlacementDimensions } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/pdfImagePlacementSizingTypes';

interface IComputeInitialImagePlacementDimensionsOptions {
    pageWidthPx: number;
    pageHeightPx: number;
    imageCssWidth: number;
    imageCssHeight: number;
}

export function computeInitialImagePlacementDimensions(
    options: IComputeInitialImagePlacementDimensionsOptions,
): IImagePlacementDimensions | null {
    const {
        pageWidthPx,
        pageHeightPx,
        imageCssWidth,
        imageCssHeight,
    } = options;
    if (
        pageWidthPx <= 0
        || pageHeightPx <= 0
        || imageCssWidth <= 0
        || imageCssHeight <= 0
    ) {
        return null;
    }

    const maxCssWidth = pageWidthPx * 0.4;
    const maxCssHeight = pageHeightPx * 0.4;
    const minCssWidth = Math.min(pageWidthPx * 0.12, maxCssWidth);
    const minCssHeight = Math.min(pageHeightPx * 0.12, maxCssHeight);

    const fitScale = Math.min(
        1,
        maxCssWidth / imageCssWidth,
        maxCssHeight / imageCssHeight,
    );
    let targetCssWidth = imageCssWidth * fitScale;
    let targetCssHeight = imageCssHeight * fitScale;

    const minScaleFactor = Math.max(
        targetCssWidth < minCssWidth ? minCssWidth / targetCssWidth : 1,
        targetCssHeight < minCssHeight ? minCssHeight / targetCssHeight : 1,
    );
    const maxScaleFactor = Math.min(
        maxCssWidth / targetCssWidth,
        maxCssHeight / targetCssHeight,
    );
    if (minScaleFactor > 1 && maxScaleFactor >= 1) {
        const scaleUpFactor = Math.min(minScaleFactor, maxScaleFactor);
        targetCssWidth *= scaleUpFactor;
        targetCssHeight *= scaleUpFactor;
    }

    return {
        width: targetCssWidth / pageWidthPx,
        height: targetCssHeight / pageHeightPx,
    };
}
