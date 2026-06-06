import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createPdfSearchMatchScroller } from '@app/utils/pdf-viewer/pdf-search-match-scroller/createPdfSearchMatchScroller';
import { cast } from '@tests/helpers/cast';

function createContainerWithMountedPage(pageNumber: number) {
    const pageContainer = cast<HTMLElement>({dataset: {page: String(pageNumber)}});

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

    it('waits for highlight-ready direct scroll without an intermediate page jump', async () => {
        const scrollToPage = vi.fn();
        const scheduleRenderForSinglePage = vi.fn();
        const beginSearchNavigation = vi.fn();
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
            endSearchNavigation,
        });

        scroller.requestScrollToMatch(4);

        await Promise.resolve();
        await vi.runAllTimersAsync();

        expect(beginSearchNavigation).toHaveBeenCalledWith(5);
        expect(scrollToPage).not.toHaveBeenCalled();
        expect(scheduleRenderForSinglePage).toHaveBeenCalledWith(5);
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
