import { nextTick } from 'vue';
import { getPageContainer } from '@app/composables/pdf/pdfPageBufferManager';

interface ICurrentSearchMatch {pageIndex: number;}

interface IPdfSearchMatchScrollerDeps {
    getContainer: () => HTMLElement | null;
    getCurrentSearchMatch: () => ICurrentSearchMatch | null;
    getCurrentMatchRangeRect: (textLayerDiv: HTMLElement) => DOMRect | null;
    scrollToCurrentMatch: () => boolean;
    scheduleRenderForSinglePage: (pageNumber: number) => void;
    scrollToPage?: (pageNumber: number) => void;
}

export function createPdfSearchMatchScroller(deps: IPdfSearchMatchScrollerDeps) {
    let scrollToMatchRequestId = 0;

    function scheduleScrollCorrection(requestId: number) {
        if (typeof window === 'undefined') {
            return;
        }

        let observer: MutationObserver | null = null;

        function disconnectObserver() {
            observer?.disconnect();
            observer = null;
        }

        const correctIfNeeded = () => {
            if (requestId !== scrollToMatchRequestId) {
                disconnectObserver();
                return;
            }

            const containerRoot = deps.getContainer();
            const currentMatch = deps.getCurrentSearchMatch();
            if (!containerRoot || !currentMatch) {
                disconnectObserver();
                return;
            }

            const targetContainer = getPageContainer(containerRoot, currentMatch.pageIndex);
            if (!targetContainer) {
                deps.scheduleRenderForSinglePage(currentMatch.pageIndex + 1);
                if (!observer) {
                    observer = new MutationObserver(() => {
                        if (requestId !== scrollToMatchRequestId) {
                            disconnectObserver();
                            return;
                        }
                        if (getPageContainer(containerRoot, currentMatch.pageIndex)) {
                            disconnectObserver();
                            correctIfNeeded();
                        }
                    });
                    observer.observe(containerRoot, {
                        childList: true,
                        subtree: false, 
                    });
                }
                return;
            }

            const textLayerDiv = targetContainer.querySelector<HTMLElement>('.text-layer');
            if (!textLayerDiv) {
                deps.scheduleRenderForSinglePage(currentMatch.pageIndex + 1);
                if (!observer) {
                    observer = new MutationObserver(() => {
                        if (requestId !== scrollToMatchRequestId) {
                            disconnectObserver();
                            return;
                        }
                        if (targetContainer.querySelector('.text-layer')) {
                            disconnectObserver();
                            correctIfNeeded();
                        }
                    });
                    observer.observe(targetContainer, {
                        childList: true,
                        subtree: true, 
                    });
                }
                return;
            }

            disconnectObserver();

            const rect = deps.getCurrentMatchRangeRect(textLayerDiv);
            if (!rect || (rect.width === 0 && rect.height === 0)) {
                return;
            }

            const containerRect = containerRoot.getBoundingClientRect();
            const centerDelta = (rect.top + rect.height / 2) - (containerRect.top + containerRect.height / 2);
            const isVisible = rect.bottom > containerRect.top + 16 && rect.top < containerRect.bottom - 16;
            const isCentered = Math.abs(centerDelta) < 8;
            if (isVisible && isCentered) {
                return;
            }

            deps.scrollToCurrentMatch();
        };

        requestAnimationFrame(() => {
            correctIfNeeded();
            requestAnimationFrame(() => {
                correctIfNeeded();
            });
        });
        setTimeout(correctIfNeeded, 120);
        setTimeout(correctIfNeeded, 350);
        setTimeout(correctIfNeeded, 800);
        setTimeout(correctIfNeeded, 1500);
        setTimeout(correctIfNeeded, 3000);
    }

    function requestScrollToMatch(matchPageIndex: number | null) {
        const requestId = ++scrollToMatchRequestId;

        if (matchPageIndex === null || typeof window === 'undefined') {
            return;
        }

        const maxAttempts = 8;
        let attempts = 0;

        const tryScroll = () => {
            if (requestId !== scrollToMatchRequestId) {
                return;
            }

            const didScroll = deps.scrollToCurrentMatch();
            if (didScroll) {
                scheduleScrollCorrection(requestId);
                return;
            }

            attempts += 1;

            deps.scheduleRenderForSinglePage(matchPageIndex + 1);

            if (attempts >= maxAttempts) {
                deps.scrollToPage?.(matchPageIndex + 1 + 6);
                scheduleScrollCorrection(requestId);
                return;
            }

            requestAnimationFrame(tryScroll);
        };

        void nextTick(tryScroll);
    }

    return {
        requestScrollToMatch,
        invalidatePendingRequests: () => {
            scrollToMatchRequestId += 1;
        },
    };
}
