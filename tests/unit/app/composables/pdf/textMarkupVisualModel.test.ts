import {
    describe,
    expect,
    it,
} from 'vitest';
import { createTextMarkupDrawLayerVisualPlan } from '@app/modules/pdf-viewer/engine/text-markup-visual-model/createTextMarkupDrawLayerVisualPlan';
import { pdfTextMarkupNativeAppearance } from '@app/modules/pdf-viewer/engine/text-markup-visual-model/pdfTextMarkupNativeAppearance';

describe('textMarkupVisualModel', () => {
    it('derives draw-layer subtype geometry from normalized page boxes', () => {
        const box = {
            x: 0.1,
            y: 0.2,
            width: 0.4,
            height: 0.1,
        };
        const drawLayerRect = {
            left: 0.09,
            top: 0.19,
            width: 0.42,
            height: 0.12,
        };
        const pageDimensions = [
            600,
            800,
        ] as const;

        const underline = createTextMarkupDrawLayerVisualPlan({
            boxes: [box],
            drawLayerRect,
            pageDimensions,
            subtype: 'Underline',
        });
        const strikeout = createTextMarkupDrawLayerVisualPlan({
            boxes: [box],
            drawLayerRect,
            pageDimensions,
            subtype: 'StrikeOut',
        });

        expect(underline?.viewBox).toBe('0 0 1 1');
        expect(underline?.paths).toEqual([{
            d: 'M 0.02381 0.903125 L 0.97619 0.903125',
            strokeWidthPdfUnits: pdfTextMarkupNativeAppearance.underlineStrokeWidth,
        }]);
        expect(strikeout?.paths).toEqual([{
            d: 'M 0.02381 0.5 L 0.97619 0.5',
            strokeWidthPdfUnits: pdfTextMarkupNativeAppearance.strikeOutStrokeWidth,
        }]);
    });
});
