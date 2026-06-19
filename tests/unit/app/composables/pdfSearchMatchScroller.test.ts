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
        });

        scroller.requestScrollToMatch(4);

        expect(beginSearchNavigation).toHaveBeenCalledWith(5);
        expect(revealSearchNavigationTarget).toHaveBeenCalledWith(5);
        expect(scheduleRenderForSinglePage).toHaveBeenCalledWith(5);

        await Promise.resolve();
        await vi.runAllTimersAsync();

        expect(scrollToPage).not.toHaveBeenCalled();
        expect(scheduleRenderForSinglePage).toHaveBeenCalledWith(5);
        expect(scheduleRenderForSinglePage).toHaveBeenCalledTimes(1);
        expect(endSearchNavigation).toHaveBeenCalledWith(120);
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
});
