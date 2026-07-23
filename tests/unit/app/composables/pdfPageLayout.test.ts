import {
    describe,
    expect,
    it,
} from 'vitest';
import { buildPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/buildPageLayoutMetrics';
import {
    getLayoutContentHeight,
    getLayoutPageHeight,
    getLayoutPageTop,
    getLayoutRowHeight,
} from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import { getLeadingSpacerHeightForPage } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getLeadingSpacerHeightForPage';
import { getTrailingSpacerHeightForPage } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getTrailingSpacerHeightForPage';
import { normalizePageMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';
import { resolveDocumentBaseMetric } from '@app/modules/pdf-viewer/engine/pdf-page-layout/resolveDocumentBaseMetric';
import type { IPdfPageMetric } from '@app/types/pdfUi';

describe('pdfPageLayout', () => {
    it('reuses immutable base topology across scale-only changes', () => {
        const pageMetrics = Array.from({length: 10_000}, (_, index) => ({
            width: 300 + index % 3,
            height: 500 + index % 5,
        }));
        const createLayout = (scale: number, pageMetricsVersion = 1) => buildPageLayoutMetrics({
            pageMetrics,
            pageMetricsVersion,
            totalPages: pageMetrics.length,
            viewMode: 'facing',
            scale,
            gap: 17,
            paddingTop: 19,
            paddingBottom: 23,
            fallbackWidth: null,
            fallbackHeight: null,
        });

        const first = createLayout(1);
        const scaled = createLayout(1.375);
        const revised = createLayout(1.375, 2);
        expect(first?.base).toBe(scaled?.base);
        expect(revised?.base).not.toBe(first?.base);
        expect(Object.isFrozen(first?.base)).toBe(true);
        expect(Object.isFrozen(first?.base.pageHeights)).toBe(true);
        expect(Object.keys(scaled ?? {}).sort()).toEqual([
            'base',
            'gap',
            'paddingBottom',
            'paddingTop',
            'scale',
        ]);
        expect(scaled?.gap).toBe(17);
        expect(scaled?.paddingTop).toBe(19);
        expect(scaled?.paddingBottom).toBe(23);
    });

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
        expect(layout && layout.base.pageHeights.map((_height, index) => getLayoutPageTop(layout, index))).toEqual([
            20,
            240,
            660,
        ]);
        expect(layout && layout.base.pageHeights.map((_height, index) => getLayoutPageHeight(layout, index))).toEqual([
            200,
            400,
            240,
        ]);
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
        expect(layout && layout.base.pageHeights.map((_height, index) => getLayoutPageTop(layout, index))).toEqual([
            20,
            20,
            180,
            180,
            360,
        ]);
        expect(layout?.base.pageRowIndices).toEqual([
            0,
            0,
            1,
            1,
            2,
        ]);
        expect(layout?.base.rowStartPages).toEqual([
            1,
            3,
            5,
        ]);
        expect(layout?.base.rowEndPages).toEqual([
            2,
            4,
            5,
        ]);
        expect(layout && layout.base.rowHeights.map((_height, index) => getLayoutRowHeight(layout, index))).toEqual([
            140,
            160,
            110,
        ]);
        expect(layout && getLayoutContentHeight(layout)).toBe(490);
        expect(getLeadingSpacerHeightForPage(layout!, 3)).toBe(140);
        expect(getTrailingSpacerHeightForPage(layout!, 2)).toBe(290);
    });

    it('resolves document base dimensions from mixed page sizes', () => {
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
    });

    it('estimates missing page metrics from nearest known pages instead of the widest fallback', () => {
        const sparseMetrics: IPdfPageMetric[] = [];
        sparseMetrics[0] = {
            width: 300,
            height: 500,
        };
        sparseMetrics[3] = {
            width: 320,
            height: 520,
        };

        expect(normalizePageMetrics({
            pageMetrics: sparseMetrics,
            totalPages: 5,
            fallbackWidth: 1200,
            fallbackHeight: 1600,
        })).toEqual([
            {
                width: 300,
                height: 500,
            },
            {
                width: 300,
                height: 500,
            },
            {
                width: 320,
                height: 520,
            },
            {
                width: 320,
                height: 520,
            },
            {
                width: 320,
                height: 520,
            },
        ]);
    });
});
