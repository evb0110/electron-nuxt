import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createTextMarkupDrawLayerVisualPlan,
    createTextMarkupLiveVisualPlan,
    PDF_TEXT_MARKUP_NATIVE_APPEARANCE,
} from '@app/composables/pdf/textMarkupVisualModel';

describe('textMarkupVisualModel', () => {
    it('derives live underline and strikeout geometry from the native PDF.js contract', () => {
        const box = {
            x: 0.1,
            y: 0.2,
            width: 0.4,
            height: 0.1,
        };
        const editorRect = {
            left: 0.1,
            top: 0.2,
            width: 0.4,
            height: 0.1,
        };
        const pageDimensions = [
            600,
            800,
        ] as const;

        const underline = createTextMarkupLiveVisualPlan({
            boxes: [box],
            editorRect,
            pageDimensions,
            subtype: 'Underline',
        });
        const strikeout = createTextMarkupLiveVisualPlan({
            boxes: [box],
            editorRect,
            pageDimensions,
            subtype: 'StrikeOut',
        });

        expect(underline?.paths).toEqual([{
            d: 'M 0 0.098375 L 0.4 0.098375',
            strokeWidthPdfUnits: PDF_TEXT_MARKUP_NATIVE_APPEARANCE.underlineStrokeWidth,
        }]);
        expect(strikeout?.paths).toEqual([{
            d: 'M 0 0.05 L 0.4 0.05',
            strokeWidthPdfUnits: PDF_TEXT_MARKUP_NATIVE_APPEARANCE.strikeOutStrokeWidth,
        }]);
    });

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
            strokeWidthPdfUnits: PDF_TEXT_MARKUP_NATIVE_APPEARANCE.underlineStrokeWidth,
        }]);
        expect(strikeout?.paths).toEqual([{
            d: 'M 0.02381 0.5 L 0.97619 0.5',
            strokeWidthPdfUnits: PDF_TEXT_MARKUP_NATIVE_APPEARANCE.strikeOutStrokeWidth,
        }]);
    });
});
