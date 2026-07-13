import {
    describe,
    expect,
    it,
} from 'vitest';
import type { TPdfViewMode } from '@contracts/shared';
import { buildPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/buildPageLayoutMetrics';
import { getInterSegmentSpacerHeight } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getInterSegmentSpacerHeight';
import { getLeadingSpacerHeightForPage } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getLeadingSpacerHeightForPage';
import { getTrailingSpacerHeightForPage } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getTrailingSpacerHeightForPage';

const GAP = 20;
const PAGE_HEIGHT = 100;
const PADDING = 20;

function createLayout(totalPages: number, viewMode: TPdfViewMode) {
    const layout = buildPageLayoutMetrics({
        pageMetrics: Array.from({length: totalPages}, () => ({
            width: 300,
            height: PAGE_HEIGHT,
        })),
        totalPages,
        viewMode,
        scale: 1,
        gap: GAP,
        paddingTop: PADDING,
        paddingBottom: PADDING,
        fallbackWidth: 300,
        fallbackHeight: PAGE_HEIGHT,
    });
    expect(layout).not.toBeNull();
    return layout!;
}

function getPageBottom(layout: ReturnType<typeof createLayout>, pageNumber: number) {
    const pageIndex = pageNumber - 1;
    const rowIndex = layout.pageRowIndices[pageIndex] ?? 0;
    return (layout.pageTops[pageIndex] ?? 0) + (layout.rowHeights[rowIndex] ?? 0);
}

describe('virtual PDF segment spacer geometry', () => {
    it('subtracts both track-owned gaps from a single-page inter-segment spacer', () => {
        const layout = createLayout(8, 'single');
        const previousPage = 2;
        const nextPage = 6;
        const spacerHeight = getInterSegmentSpacerHeight(layout, previousPage, nextPage);

        expect(spacerHeight).toBe(340);
        expect(
            getPageBottom(layout, previousPage) + GAP + spacerHeight + GAP,
        ).toBe(layout.pageTops[nextPage - 1]);
    });

    it('subtracts both grid-row gaps from a facing-mode inter-segment spacer', () => {
        const layout = createLayout(12, 'facing');
        const previousPage = 4;
        const nextPage = 9;
        const spacerHeight = getInterSegmentSpacerHeight(layout, previousPage, nextPage);

        expect(spacerHeight).toBe(220);
        expect(
            getPageBottom(layout, previousPage) + GAP + spacerHeight + GAP,
        ).toBe(layout.pageTops[nextPage - 1]);
    });

    it.each([
        {
            viewMode: 'single' as const,
            totalPages: 8,
            firstMountedPage: 3,
            lastMountedPage: 5,
        },
        {
            viewMode: 'facing' as const,
            totalPages: 12,
            firstMountedPage: 3,
            lastMountedPage: 6,
        },
    ])('preserves the analytical track extent in $viewMode mode', ({
        viewMode,
        totalPages,
        firstMountedPage,
        lastMountedPage,
    }) => {
        const layout = createLayout(totalPages, viewMode);
        const leadingSpacer = getLeadingSpacerHeightForPage(layout, firstMountedPage);
        const trailingSpacer = getTrailingSpacerHeightForPage(layout, lastMountedPage);
        const firstPageTop = PADDING + leadingSpacer + (leadingSpacer > 0 ? GAP : 0);
        const reconstructedContentHeight = getPageBottom(layout, lastMountedPage)
            + (trailingSpacer > 0 ? GAP + trailingSpacer : 0)
            + PADDING;

        expect(firstPageTop).toBe(layout.pageTops[firstMountedPage - 1]);
        expect(reconstructedContentHeight).toBe(layout.contentHeight);
    });
});
