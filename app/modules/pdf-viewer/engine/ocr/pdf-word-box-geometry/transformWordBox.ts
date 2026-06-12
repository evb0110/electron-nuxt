import type { IOcrWord } from '@app/types/pdf';
import { BrowserLogger } from '@app/utils/browserLogger';

export function transformWordBox(
    word: IOcrWord,
    imageDimensionWidth: number | undefined,
    imageDimensionHeight: number | undefined,
    renderedPageWidth: number,
    renderedPageHeight: number,
) {
    if (!imageDimensionWidth || !imageDimensionHeight) {
        BrowserLogger.warn('word-box', 'Missing dimensions', {
            imageDimensionWidth,
            imageDimensionHeight,
            renderedPageWidth,
            renderedPageHeight,
            word: word.text,
        });
        return {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            isCurrent: false,
        };
    }

    const scaleX = renderedPageWidth / imageDimensionWidth;
    const scaleY = renderedPageHeight / imageDimensionHeight;

    const scale = Math.min(scaleX, scaleY);
    if (Math.abs(scaleX - scaleY) > 0.05) {
        BrowserLogger.warn('word-box', 'Asymmetric scales detected - using uniform scaling', {
            scaleX: scaleX.toFixed(3),
            scaleY: scaleY.toFixed(3),
            usingUniformScale: scale.toFixed(3),
        });
    }

    const x = word.x * scale;
    const y = word.y * scale;
    const width = word.width * scale;
    const height = word.height * scale;

    if (y > renderedPageHeight || width > renderedPageWidth || height > renderedPageHeight) {
        BrowserLogger.error('word-box', 'Box out of bounds', {
            word: word.text,
            wordCoords: {
                x: word.x,
                y: word.y,
                w: word.width,
                h: word.height,
            },
            imageDim: {
                w: imageDimensionWidth,
                h: imageDimensionHeight,
            },
            renderedDim: {
                w: renderedPageWidth,
                h: renderedPageHeight,
            },
            scales: {
                scaleX,
                scaleY,
                uniformScale: scale,
            },
            transformed: {
                x,
                y,
                width,
                height,
            },
            isOffScreen: y > renderedPageHeight,
            relativePos: {
                yPercent: ((y / renderedPageHeight) * 100).toFixed(1),
                widthPercent: ((width / renderedPageWidth) * 100).toFixed(1),
                heightPercent: ((height / renderedPageHeight) * 100).toFixed(1),
            },
        });
    }

    return {
        x,
        y,
        width,
        height,
        isCurrent: false,
    };
}
