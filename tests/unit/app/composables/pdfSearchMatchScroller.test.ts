import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createPdfSearchMatchScroller } from '@app/modules/pdf-viewer/engine/pdf-search-match-scroller/createPdfSearchMatchScroller';
import { cast } from '@tests/helpers/cast';

function createContainerWithMountedPage(
    pageNumber: number,
    options: {
        hasCanvas?: boolean;
        rendered?: boolean;
        textLayerReady?: boolean;
        textLayerRendering?: boolean;
    } = {},
) {
    const {
        hasCanvas,
        rendered = true,
        textLayerReady = true,
        textLayerRendering = false,
    } = options;
    const textLayerDataset = {
        ...(textLayerReady ? {pdfTextLayerReady: 'true'} : {}),
        ...(textLayerRendering ? {pdfTextLayerRendering: 'true'} : {}),
    };
    const textLayer = cast<HTMLElement>({dataset: textLayerDataset});
    const canvas = cast<HTMLCanvasElement>({});
    const hasMountedCanvas = hasCanvas ?? rendered;
    const pageContainer = cast<HTMLElement>({
        dataset: {page: String(pageNumber)},
        classList: {contains: (className: string) => rendered && className === 'page_container--rendered'},
        querySelector: (selector: string) => {
            if (selector === '.text-layer') {
                return textLayer;
            }
            if (selector === '.page_canvas canvas') {
                return hasMountedCanvas ? canvas : null;
            }
            return null;
        },
    });

    return cast<HTMLElement>({
        querySelector: (selector: string) =>
            selector === `.page_container[data-page="${pageNumber}"]`
                ? pageContainer
                : null,
        querySelectorAll: () => [pageContainer],
    });
}

describe('createPdfSearchMatchScroller', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('window', {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('reveals the target page before waiting for highlight-ready direct scroll', async () => {
        const scrollToPage = vi.fn();
        const scheduleRenderForSinglePage = vi.fn();
        const beginSearchNavigation = vi.fn();
        const revealSearchNavigationTarget = vi.fn();
        const endSearchNavigation = vi.fn();
        const beginSearchTransaction = vi.fn(() => 88);
        const settleSearchTransaction = vi.fn();

        const currentMatch = {pageIndex: 4};
        let scrollCalls = 0;
        const scrollToCurrentMatch = vi.fn(() => {
            scrollCalls += 1;
            return scrollCalls >= 4;
        });

        const scroller = createPdfSearchMatchScroller({
            getContainer: () => createContainerWithMountedPage(5),
            getCurrentSearchMatch: () => currentMatch,
            scrollToCurrentMatch,
            scheduleRenderForSinglePage,
            scrollToPage,
            suppressSnap: vi.fn(),
            beginSearchNavigation,
            revealSearchNavigationTarget,
            endSearchNavigation,
            beginSearchTransaction,
            isSearchTransactionCurrent: vi.fn(() => true),
            settleSearchTransaction,
        });

        scroller.requestScrollToMatch(4);

        expect(beginSearchTransaction).toHaveBeenCalledWith(5, undefined);
        expect(beginSearchNavigation).toHaveBeenCalledWith(5);
        expect(revealSearchNavigationTarget).toHaveBeenCalledWith(5);
        expect(scheduleRenderForSinglePage).toHaveBeenCalledWith(5);

        await Promise.resolve();
        await vi.runAllTimersAsync();

        expect(scrollToPage).not.toHaveBeenCalled();
        expect(scheduleRenderForSinglePage).toHaveBeenCalledWith(5);
        expect(scheduleRenderForSinglePage).toHaveBeenCalledTimes(1);
        expect(settleSearchTransaction).toHaveBeenCalledWith(88);
        expect(endSearchNavigation).toHaveBeenCalledWith(120);
    });

    it('reveals a search target with current match geometry before the page is rendered', async () => {
        const scheduleRenderForSinglePage = vi.fn();
        const beginSearchNavigation = vi.fn();
        const revealSearchNavigationTarget = vi.fn();

        const currentMatch = {
            pageIndex: 4,
            pageWidth: 400,
            pageHeight: 800,
            words: [{
                text: 'история',
                x: 100,
                y: 600,
                width: 80,
                height: 40,
            }],
        };

        const scroller = createPdfSearchMatchScroller({
            getContainer: () => createContainerWithMountedPage(5, {
                hasCanvas: false,
                rendered: false,
                textLayerReady: false,
            }),
            getCurrentSearchMatch: () => currentMatch,
            scrollToCurrentMatch: () => false,
            scheduleRenderForSinglePage,
            scrollToPage: vi.fn(),
            suppressSnap: vi.fn(),
            beginSearchNavigation,
            revealSearchNavigationTarget,
            endSearchNavigation: vi.fn(),
        });

        scroller.requestScrollToMatch(4);

        expect(beginSearchNavigation).toHaveBeenCalledWith(5);
        const revealOptions = revealSearchNavigationTarget.mock.calls[0]?.[1];
        expect(revealOptions?.markerRect?.left).toBeCloseTo(0.25, 6);
        expect(revealOptions?.markerRect?.top).toBeCloseTo(0.75, 6);
        expect(revealOptions?.markerRect?.width).toBeCloseTo(0.2, 6);
        expect(revealOptions?.markerRect?.height).toBeCloseTo(0.05, 6);
        expect(scheduleRenderForSinglePage).toHaveBeenCalledWith(5);

        scroller.invalidatePendingRequests();
    });

    it('waits for the target page canvas before treating a match scroll as successful', async () => {
        const scrollToCurrentMatch = vi.fn(() => true);
        const scheduleRenderForSinglePage = vi.fn();
        let hasCanvas = false;

        setTimeout(() => {
            hasCanvas = true;
        }, 200);

        const scroller = createPdfSearchMatchScroller({
            getContainer: () => createContainerWithMountedPage(5, {
                rendered: true,
                textLayerReady: true,
                hasCanvas,
            }),
            getCurrentSearchMatch: () => ({pageIndex: 4}),
            scrollToCurrentMatch,
            scheduleRenderForSinglePage,
            scrollToPage: vi.fn(),
            suppressSnap: vi.fn(),
            beginSearchNavigation: vi.fn(),
            endSearchNavigation: vi.fn(),
        });

        scroller.requestScrollToMatch(4);

        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(199);

        expect(scrollToCurrentMatch).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(80);

        expect(scheduleRenderForSinglePage).toHaveBeenCalledWith(5);
        expect(scrollToCurrentMatch).toHaveBeenCalledTimes(1);
    });

    it('waits for pending render finalization before using a mounted stale canvas', async () => {
        const scrollToCurrentMatch = vi.fn(() => true);
        const scheduleRenderForSinglePage = vi.fn();
        let renderPending = true;
        let rendered = false;

        setTimeout(() => {
            renderPending = false;
            rendered = true;
        }, 200);

        const scroller = createPdfSearchMatchScroller({
            getContainer: () => createContainerWithMountedPage(5, {
                rendered,
                textLayerReady: true,
                hasCanvas: true,
            }),
            getCurrentSearchMatch: () => ({pageIndex: 4}),
            scrollToCurrentMatch,
            scheduleRenderForSinglePage,
            scrollToPage: vi.fn(),
            suppressSnap: vi.fn(),
            beginSearchNavigation: vi.fn(),
            endSearchNavigation: vi.fn(),
            isPageRenderPending: () => renderPending,
        });

        scroller.requestScrollToMatch(4);

        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(199);

        expect(scrollToCurrentMatch).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(80);

        expect(scheduleRenderForSinglePage).toHaveBeenCalledWith(5);
        expect(scrollToCurrentMatch).toHaveBeenCalledTimes(1);
    });

    it('does not restart the target page render on every highlight poll', async () => {
        const scheduleRenderForSinglePage = vi.fn();

        const scroller = createPdfSearchMatchScroller({
            getContainer: () => createContainerWithMountedPage(12),
            getCurrentSearchMatch: () => ({pageIndex: 11}),
            scrollToCurrentMatch: () => false,
            scheduleRenderForSinglePage,
            scrollToPage: vi.fn(),
            suppressSnap: vi.fn(),
            beginSearchNavigation: vi.fn(),
            endSearchNavigation: vi.fn(),
        });

        scroller.requestScrollToMatch(11);

        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(599);

        expect(scheduleRenderForSinglePage).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);

        expect(scheduleRenderForSinglePage).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(599);

        expect(scheduleRenderForSinglePage).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(1);

        expect(scheduleRenderForSinglePage).toHaveBeenCalledTimes(3);
    });

    it('keeps waiting past the normal deadline while the target page render is still pending', async () => {
        const scrollToPage = vi.fn();
        const endSearchNavigation = vi.fn();
        let renderPending = true;
        let canScrollToMatch = false;

        setTimeout(() => {
            renderPending = false;
            canScrollToMatch = true;
        }, 3500);

        const scroller = createPdfSearchMatchScroller({
            getContainer: () => createContainerWithMountedPage(25, {
                rendered: !renderPending,
                textLayerReady: !renderPending,
            }),
            getCurrentSearchMatch: () => ({pageIndex: 24}),
            scrollToCurrentMatch: () => canScrollToMatch,
            scheduleRenderForSinglePage: vi.fn(),
            scrollToPage,
            suppressSnap: vi.fn(),
            beginSearchNavigation: vi.fn(),
            endSearchNavigation,
            isPageRenderPending: () => renderPending,
        });

        scroller.requestScrollToMatch(24);

        await Promise.resolve();
        endSearchNavigation.mockClear();
        await vi.advanceTimersByTimeAsync(3000);

        expect(scrollToPage).not.toHaveBeenCalled();
        expect(endSearchNavigation).not.toHaveBeenCalledWith(0);

        await vi.advanceTimersByTimeAsync(600);

        expect(scrollToPage).not.toHaveBeenCalled();
        expect(endSearchNavigation).toHaveBeenCalledWith(120);
    });

    it('does not fall back to page-level positioning after the match target changes', async () => {
        const scrollToPage = vi.fn();
        let currentMatch: { pageIndex: number } | null = {pageIndex: 9};

        const scroller = createPdfSearchMatchScroller({
            getContainer: () => createContainerWithMountedPage(10),
            getCurrentSearchMatch: () => currentMatch,
            scrollToCurrentMatch: () => false,
            scheduleRenderForSinglePage: vi.fn(),
            scrollToPage,
            suppressSnap: vi.fn(),
            beginSearchNavigation: vi.fn(),
            endSearchNavigation: vi.fn(),
        });

        scroller.requestScrollToMatch(9);
        currentMatch = {pageIndex: 1};

        await Promise.resolve();
        await vi.runAllTimersAsync();

        expect(scrollToPage).not.toHaveBeenCalled();
    });

    it('cancels a deferred search scroll when its transaction becomes stale', async () => {
        const scrollToPage = vi.fn();
        const cancelSearchTransaction = vi.fn();
        let isCurrent = true;

        const scroller = createPdfSearchMatchScroller({
            getContainer: () => createContainerWithMountedPage(10, {
                hasCanvas: false,
                rendered: false,
                textLayerReady: false,
            }),
            getCurrentSearchMatch: () => ({pageIndex: 9}),
            scrollToCurrentMatch: () => false,
            scheduleRenderForSinglePage: vi.fn(),
            scrollToPage,
            suppressSnap: vi.fn(),
            beginSearchNavigation: vi.fn(),
            endSearchNavigation: vi.fn(),
            beginSearchTransaction: vi.fn(() => 91),
            isSearchTransactionCurrent: vi.fn(() => isCurrent),
            cancelSearchTransaction,
        });

        scroller.requestScrollToMatch(9);
        await Promise.resolve();
        isCurrent = false;
        await vi.advanceTimersByTimeAsync(80);

        expect(cancelSearchTransaction).toHaveBeenCalledWith(91);
        expect(scrollToPage).not.toHaveBeenCalled();
    });

    it('falls back to page-level positioning once on timeout', async () => {
        const scrollToPage = vi.fn();
        const endSearchNavigation = vi.fn();

        const scroller = createPdfSearchMatchScroller({
            getContainer: () => createContainerWithMountedPage(10),
            getCurrentSearchMatch: () => ({pageIndex: 9}),
            scrollToCurrentMatch: () => false,
            scheduleRenderForSinglePage: vi.fn(),
            scrollToPage,
            suppressSnap: vi.fn(),
            beginSearchNavigation: vi.fn(),
            endSearchNavigation,
        });

        scroller.requestScrollToMatch(9);

        await Promise.resolve();
        await vi.runAllTimersAsync();

        expect(scrollToPage).toHaveBeenCalledTimes(1);
        expect(scrollToPage).toHaveBeenNthCalledWith(1, 10, {preferExactDom: true});
        expect(endSearchNavigation).toHaveBeenCalledWith(0);
    });

    it('preserves current match geometry when falling back to page-level positioning', async () => {
        const scrollToPage = vi.fn();

        const scroller = createPdfSearchMatchScroller({
            getContainer: () => createContainerWithMountedPage(10),
            getCurrentSearchMatch: () => ({
                pageIndex: 9,
                pageWidth: 1000,
                pageHeight: 2000,
                words: [{
                    text: 'история',
                    x: 250,
                    y: 1500,
                    width: 100,
                    height: 50,
                }],
            }),
            scrollToCurrentMatch: () => false,
            scheduleRenderForSinglePage: vi.fn(),
            scrollToPage,
            suppressSnap: vi.fn(),
            beginSearchNavigation: vi.fn(),
            endSearchNavigation: vi.fn(),
        });

        scroller.requestScrollToMatch(9);

        await Promise.resolve();
        await vi.runAllTimersAsync();

        expect(scrollToPage).toHaveBeenCalledTimes(1);
        const fallbackOptions = scrollToPage.mock.calls[0]?.[1];
        expect(fallbackOptions?.preferExactDom).toBe(true);
        expect(fallbackOptions?.markerRect?.left).toBeCloseTo(0.25, 6);
        expect(fallbackOptions?.markerRect?.top).toBeCloseTo(0.75, 6);
        expect(fallbackOptions?.markerRect?.width).toBeCloseTo(0.1, 6);
        expect(fallbackOptions?.markerRect?.height).toBeCloseTo(0.025, 6);
    });
});
