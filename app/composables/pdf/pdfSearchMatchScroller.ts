import { getPageContainer } from '@app/composables/pdf/pdfPageBufferManager';
import { logPdfNav } from '@app/utils/pdf-nav-log';
import { delay } from 'es-toolkit/promise';

interface ICurrentSearchMatch {pageIndex: number;}

interface IPdfSearchMatchScrollerDeps {
    getContainer: () => HTMLElement | null;
    getCurrentSearchMatch: () => ICurrentSearchMatch | null;
    scrollToCurrentMatch: () => boolean;
    scheduleRenderForSinglePage: (pageNumber: number) => void;
    scrollToPage?: (
        pageNumber: number,
        options?: { preferExactDom?: boolean; },
    ) => void;
    suppressSnap?: () => void;
    beginSearchNavigation?: (pageNumber: number) => void;
    endSearchNavigation?: (settleMs?: number) => void;
}

interface IPendingRequestToken {
    id: number;
    canceled: boolean;
}

const SEARCH_SCROLL_RETRY_DELAY_MS = 40;
const SEARCH_SCROLL_WAIT_TIMEOUT_MS = 1500;
const SEARCH_SCROLL_SETTLE_MS = 120;

export function createPdfSearchMatchScroller(deps: IPdfSearchMatchScrollerDeps) {
    let requestCounter = 0;
    let activeToken: IPendingRequestToken | null = null;

    function cancelActiveRequest(settleMs = 0) {
        if (activeToken) {
            activeToken.canceled = true;
            activeToken = null;
        }
        deps.endSearchNavigation?.(settleMs);
    }

    function isTokenActive(token: IPendingRequestToken) {
        return !token.canceled && activeToken?.id === token.id;
    }

    function isStillTargetingPage(targetPageIndex: number) {
        const currentMatch = deps.getCurrentSearchMatch();
        return !!currentMatch && currentMatch.pageIndex === targetPageIndex;
    }

    async function waitForMatchAndScroll(
        token: IPendingRequestToken,
        targetPageIndex: number,
    ) {
        const deadline = Date.now() + SEARCH_SCROLL_WAIT_TIMEOUT_MS;
        let attempt = 0;

        while (Date.now() < deadline) {
            if (!isTokenActive(token)) {
                return false;
            }

            if (!isStillTargetingPage(targetPageIndex)) {
                logPdfNav(
                    `[PDF-NAV] requestScrollToMatch aborting: match changed from pageIndex=${targetPageIndex} to ${deps.getCurrentSearchMatch()?.pageIndex ?? 'null'}`,
                );
                return false;
            }

            attempt += 1;
            const matchScrolled = deps.scrollToCurrentMatch();
            logPdfNav(
                `[PDF-NAV] tryScrollNow attempt=${attempt} scrollToCurrentMatch=${matchScrolled}`,
            );
            if (matchScrolled) {
                return true;
            }

            deps.scheduleRenderForSinglePage(targetPageIndex + 1);
            const containerRoot = deps.getContainer();
            const pageContainer = containerRoot
                ? getPageContainer(containerRoot, targetPageIndex)
                : null;

            logPdfNav(
                `[PDF-NAV] waitForTextLayerAndScroll: pageIndex=${targetPageIndex} containerInDOM=${!!pageContainer}`,
            );

            await delay(SEARCH_SCROLL_RETRY_DELAY_MS);
        }

        return false;
    }

    function requestScrollToMatch(matchPageIndex: number | null) {
        const requestId = ++requestCounter;
        cancelActiveRequest(0);

        logPdfNav(
            `[PDF-NAV] requestScrollToMatch pageIndex=${matchPageIndex} requestId=${requestId}`,
        );

        if (matchPageIndex === null || typeof window === 'undefined') {
            return;
        }

        const token: IPendingRequestToken = {
            id: requestId,
            canceled: false,
        };
        activeToken = token;

        deps.beginSearchNavigation?.(matchPageIndex + 1);

        void nextTick(async () => {
            if (!isTokenActive(token)) {
                return;
            }

            const currentMatch = deps.getCurrentSearchMatch();
            if (!currentMatch || currentMatch.pageIndex !== matchPageIndex) {
                logPdfNav(
                    `[PDF-NAV] requestScrollToMatch stale requestId=${requestId} currentMatch=${currentMatch?.pageIndex ?? 'null'}`,
                );
                cancelActiveRequest(0);
                return;
            }

            if (deps.scrollToCurrentMatch()) {
                logPdfNav('[PDF-NAV] fast-path: scrollToCurrentMatch succeeded immediately');
                deps.suppressSnap?.();
                cancelActiveRequest(SEARCH_SCROLL_SETTLE_MS);
                return;
            }

            logPdfNav(
                `[PDF-NAV] deferring page jump; waiting for match-ready scroll on page=${matchPageIndex + 1}`,
            );
            deps.scheduleRenderForSinglePage(matchPageIndex + 1);

            const didScroll = await waitForMatchAndScroll(token, matchPageIndex);
            if (!isTokenActive(token)) {
                return;
            }

            if (!didScroll) {
                logPdfNav(
                    `[PDF-NAV] requestScrollToMatch timed out pageIndex=${matchPageIndex} requestId=${requestId}`,
                );
                // Fallback keeps navigation deterministic even when highlight mapping is unavailable.
                deps.suppressSnap?.();
                deps.scrollToPage?.(matchPageIndex + 1, { preferExactDom: true });
                cancelActiveRequest(0);
                return;
            }

            deps.suppressSnap?.();
            cancelActiveRequest(SEARCH_SCROLL_SETTLE_MS);
        });
    }

    return {
        requestScrollToMatch,
        invalidatePendingRequests: () => {
            cancelActiveRequest(0);
        },
    };
}
