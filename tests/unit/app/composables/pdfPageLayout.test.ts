import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildPageLayoutMetrics,
    getLeadingSpacerHeight,
    getTrailingSpacerHeight,
    resolveDocumentBaseMetric,
    resolveSpreadBaseWidth,
} from '@app/composables/pdf/pdfPageLayout';

describe('pdfPageLayout', () => {
    it('builds per-page tops from variable page heights', () => {
        const layout = buildPageLayoutMetrics({
            pageMetrics: [
                {
                    width: 400,
                    height: 100,
                },
                {
                    width: 300,
                    height: 200,
                },
                {
                    width: 500,
                    height: 120,
                },
            ],
            totalPages: 3,
            scale: 2,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
            fallbackWidth: 400,
            fallbackHeight: 100,
        });

        expect(layout).not.toBeNull();
        expect(layout?.pageTops).toEqual([
            20,
            240,
            660,
        ]);
        expect(layout?.pageHeights).toEqual([
            200,
            400,
            240,
        ]);
    });

    it('computes spacer heights from the real hidden-page heights', () => {
        const layout = buildPageLayoutMetrics({
            pageMetrics: [
                {
                    width: 400,
                    height: 100,
                },
                {
                    width: 400,
                    height: 300,
                },
                {
                    width: 400,
                    height: 150,
                },
                {
                    width: 400,
                    height: 250,
                },
            ],
            totalPages: 4,
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
            fallbackWidth: 400,
            fallbackHeight: 100,
        });

        expect(layout).not.toBeNull();
        expect(getLeadingSpacerHeight(layout!, 2)).toBe(420);
        expect(getTrailingSpacerHeight(layout!, 1)).toBe(250);
    });

    it('resolves document and spread base dimensions from mixed page sizes', () => {
        const pageMetrics = [
            {
                width: 300,
                height: 500,
            },
            {
                width: 320,
                height: 480,
            },
            {
                width: 700,
                height: 450,
            },
            {
                width: 280,
                height: 900,
            },
        ];

        expect(resolveDocumentBaseMetric(pageMetrics, 'width')).toBe(700);
        expect(resolveDocumentBaseMetric(pageMetrics, 'height')).toBe(900);
        expect(resolveSpreadBaseWidth(pageMetrics, 'single', 4)).toBe(700);
        expect(resolveSpreadBaseWidth(pageMetrics, 'facing', 4)).toBe(980);
        expect(resolveSpreadBaseWidth(pageMetrics, 'facing-first-single', 4)).toBe(1020);
    });
});
