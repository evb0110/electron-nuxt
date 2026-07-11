import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createPdfSearchMatchScroller } from '@app/modules/pdf-viewer/engine/pdf-search-match-scroller/createPdfSearchMatchScroller';

describe('createPdfSearchMatchScroller', () => {
    it('emits exactly one semantic rect request with no polling or private scroll', () => {
        const revealSearchNavigationTarget = vi.fn();
        const scrollToCurrentMatch = vi.fn();
        const scheduleRenderForSinglePage = vi.fn();
        const scroller = createPdfSearchMatchScroller({
            getContainer: () => document.createElement('div'),
            getCurrentSearchMatch: () => ({
                pageIndex: 2,
                pageWidth: 200,
                pageHeight: 400,
                words: [{
                    x: 20,
                    y: 80,
                    width: 40,
                    height: 20,
                }],
            }),
            scrollToCurrentMatch,
            scheduleRenderForSinglePage,
            revealSearchNavigationTarget,
        });
        scroller.requestScrollToMatch(2);
        expect(revealSearchNavigationTarget).toHaveBeenCalledOnce();
        const marker = revealSearchNavigationTarget.mock.calls[0]?.[1]?.markerRect;
        expect(revealSearchNavigationTarget.mock.calls[0]?.[0]).toBe(3);
        expect(marker?.left).toBeCloseTo(0.1);
        expect(marker?.top).toBeCloseTo(0.2);
        expect(marker?.width).toBeCloseTo(0.2);
        expect(marker?.height).toBeCloseTo(0.05);
        expect(scrollToCurrentMatch).not.toHaveBeenCalled();
        expect(scheduleRenderForSinglePage).not.toHaveBeenCalled();
    });

    it('emits a page request when word geometry is unavailable', () => {
        const revealSearchNavigationTarget = vi.fn();
        const scroller = createPdfSearchMatchScroller({
            getContainer: () => null,
            getCurrentSearchMatch: () => ({pageIndex: 0}),
            scrollToCurrentMatch: () => false,
            scheduleRenderForSinglePage: vi.fn(),
            revealSearchNavigationTarget,
        });
        scroller.requestScrollToMatch(0);
        expect(revealSearchNavigationTarget).toHaveBeenCalledWith(1, undefined);
    });

    it('uses the authority-compatible page fallback', () => {
        const scrollToPage = vi.fn();
        const scroller = createPdfSearchMatchScroller({
            getContainer: () => null,
            getCurrentSearchMatch: () => ({pageIndex: 1}),
            scrollToCurrentMatch: () => false,
            scheduleRenderForSinglePage: vi.fn(),
            scrollToPage,
        });
        scroller.requestScrollToMatch(1);
        expect(scrollToPage).toHaveBeenCalledWith(2, {navigationSource: 'search'});
    });

    it('emits nothing for a cleared target', () => {
        const revealSearchNavigationTarget = vi.fn();
        const endSearchNavigation = vi.fn();
        const scroller = createPdfSearchMatchScroller({
            getContainer: () => null,
            getCurrentSearchMatch: () => null,
            scrollToCurrentMatch: () => false,
            scheduleRenderForSinglePage: vi.fn(),
            revealSearchNavigationTarget,
            endSearchNavigation,
        });
        scroller.requestScrollToMatch(null);
        expect(revealSearchNavigationTarget).not.toHaveBeenCalled();
        expect(endSearchNavigation).toHaveBeenCalledWith(0);
    });
});
