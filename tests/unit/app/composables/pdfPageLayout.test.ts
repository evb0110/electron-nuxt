import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildPageLayoutMetrics,
    getLeadingSpacerHeight,
    getLeadingSpacerHeightForPage,
    getTrailingSpacerHeight,
    getTrailingSpacerHeightForPage,
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
            viewMode: 'single',
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
            viewMode: 'single',
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

    it('groups facing pages into spread rows and keeps row spacer math aligned', () => {
        const layout = buildPageLayoutMetrics({
            pageMetrics: [
                {
                    width: 300,
                    height: 100,
                },
                {
                    width: 280,
                    height: 140,
                },
                {
                    width: 320,
                    height: 120,
                },
                {
                    width: 260,
                    height: 160,
                },
                {
                    width: 240,
                    height: 110,
                },
            ],
            totalPages: 5,
            viewMode: 'facing',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
            fallbackWidth: 240,
            fallbackHeight: 110,
        });

        expect(layout).not.toBeNull();
        expect(layout?.pageTops).toEqual([
            20,
            20,
            180,
            180,
            360,
        ]);
        expect(layout?.pageRowIndices).toEqual([
            0,
            0,
            1,
            1,
            2,
        ]);
        expect(layout?.rowStartPages).toEqual([
            1,
            3,
            5,
        ]);
        expect(layout?.rowEndPages).toEqual([
            2,
            4,
            5,
        ]);
        expect(layout?.rowHeights).toEqual([
            140,
            160,
            110,
        ]);
        expect(layout?.contentHeight).toBe(490);
        expect(getLeadingSpacerHeightForPage(layout!, 3)).toBe(140);
        expect(getTrailingSpacerHeightForPage(layout!, 2)).toBe(290);
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
