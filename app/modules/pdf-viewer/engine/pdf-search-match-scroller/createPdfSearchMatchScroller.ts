import { getPageContainer } from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/getPageContainer';
import { pdfViewerDomClasses } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomClasses';
import { logPdfNav } from '@app/utils/logPdfNav';
import { delay } from 'es-toolkit/promise';
import { getErrorMessage } from '@app/utils/error';

interface ICurrentSearchMatchWord {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface ICurrentSearchMatch {
    pageIndex: number;
    pageWidth?: number | undefined;
    pageHeight?: number | undefined;
    words?: ICurrentSearchMatchWord[] | undefined;
}

interface ICurrentSearchMatchMarkerRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface ISearchNavigationTargetOptions {markerRect?: ICurrentSearchMatchMarkerRect | null | undefined;}

interface IPdfSearchMatchScrollerDeps {
    getContainer: () => HTMLElement | null;
    getCurrentSearchMatch: () => ICurrentSearchMatch | null;
    scrollToCurrentMatch: () => boolean;
    scheduleRenderForSinglePage: (pageNumber: number) => void;
    scrollToPage?: (
        pageNumber: number,
        options?: { preferExactDom?: boolean; } & ISearchNavigationTargetOptions,
    ) => void;
    suppressSnap?: () => void;
    beginSearchNavigation?: (pageNumber: number) => void;
    revealSearchNavigationTarget?: (
        pageNumber: number,
        options?: ISearchNavigationTargetOptions,
    ) => void;
    endSearchNavigation?: (settleMs?: number) => void;
    isPageRenderPending?: (pageNumber: number) => boolean;
}

interface IPendingRequestToken {
    id: number;
    canceled: boolean;
}

const SEARCH_SCROLL_RETRY_DELAY_MS = 40;

const SEARCH_SCROLL_MIN_WAIT_TIMEOUT_MS = 3000;

const SEARCH_SCROLL_MAX_WAIT_TIMEOUT_MS = 12000;

const SEARCH_SCROLL_WAIT_EXTENSION_MS = 1000;

const SEARCH_RENDER_REQUEST_RETRY_MS = 600;

const SEARCH_SCROLL_SETTLE_MS = 120;

function clampRatio(value: number) {
    return Math.min(1, Math.max(0, value));
}

function resolveCurrentMatchMarkerRect(
    currentMatch: ICurrentSearchMatch | null,
    targetPageIndex: number,
): ICurrentSearchMatchMarkerRect | null {
    if (
        !currentMatch
        || currentMatch.pageIndex !== targetPageIndex
        || !Array.isArray(currentMatch.words)
        || currentMatch.words.length === 0
        || typeof currentMatch.pageWidth !== 'number'
        || !Number.isFinite(currentMatch.pageWidth)
        || currentMatch.pageWidth <= 0
        || typeof currentMatch.pageHeight !== 'number'
        || !Number.isFinite(currentMatch.pageHeight)
        || currentMatch.pageHeight <= 0
    ) {
        return null;
    }

    const boxes = currentMatch.words
        .map((word) => ({
            left: word.x,
            top: word.y,
            right: word.x + word.width,
            bottom: word.y + word.height,
        }))
        .filter(box => (
            Number.isFinite(box.left)
            && Number.isFinite(box.top)
            && Number.isFinite(box.right)
            && Number.isFinite(box.bottom)
            && box.right > box.left
            && box.bottom > box.top
        ));

    if (boxes.length === 0) {
        return null;
    }

    const left = Math.min(...boxes.map(box => box.left));
    const top = Math.min(...boxes.map(box => box.top));
    const right = Math.max(...boxes.map(box => box.right));
    const bottom = Math.max(...boxes.map(box => box.bottom));
    const normalizedLeft = clampRatio(left / currentMatch.pageWidth);
    const normalizedTop = clampRatio(top / currentMatch.pageHeight);
    const normalizedRight = clampRatio(right / currentMatch.pageWidth);
    const normalizedBottom = clampRatio(bottom / currentMatch.pageHeight);

    return {
        left: normalizedLeft,
        top: normalizedTop,
        width: Math.max(0, normalizedRight - normalizedLeft),
        height: Math.max(0, normalizedBottom - normalizedTop),
    };
}

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

    function getTargetPageWarmupState(targetPageIndex: number) {
        const containerRoot = deps.getContainer();
        const pageContainer = containerRoot
            ? getPageContainer(containerRoot, targetPageIndex)
            : null;
        const textLayer = pageContainer?.querySelector<HTMLElement>('.text-layer') ?? null;
        const pageNumber = targetPageIndex + 1;
        const renderPending = deps.isPageRenderPending?.(pageNumber) ?? false;
        const rendered = pageContainer?.classList.contains(pdfViewerDomClasses.renderedPageContainer) ?? false;
        const hasCanvas = Boolean(pageContainer?.querySelector<HTMLCanvasElement>('.page_canvas canvas'));
        const textLayerRendering = textLayer?.dataset?.pdfTextLayerRendering === 'true';
        const textLayerReady = textLayer?.dataset?.pdfTextLayerReady === 'true';
        const textLayerMarkedNotReady = textLayer?.dataset?.pdfTextLayerReady === 'false';

        return {
            containerInDOM: Boolean(pageContainer),
            renderPending,
            rendered,
            hasCanvas,
            hasTextLayer: Boolean(textLayer),
            textLayerRendering,
            textLayerReady,
            textLayerMarkedNotReady,
        };
    }

    function isTargetPageDisplayReady(state: ReturnType<typeof getTargetPageWarmupState>) {
        return state.containerInDOM
            && state.hasCanvas
            && !state.textLayerRendering
            && !state.textLayerMarkedNotReady;
    }

    function isTargetPageStillWarming(targetPageIndex: number) {
        const state = getTargetPageWarmupState(targetPageIndex);
        return !isTargetPageDisplayReady(state)
            || (state.renderPending && !state.hasCanvas)
            || state.textLayerRendering
            || state.textLayerMarkedNotReady;
    }

    async function waitForMatchAndScroll(
        token: IPendingRequestToken,
        targetPageIndex: number,
        initialRenderRequestAt: number,
    ) {
        const startedAt = Date.now();
        const maxDeadline = startedAt + SEARCH_SCROLL_MAX_WAIT_TIMEOUT_MS;
        let deadline = startedAt + SEARCH_SCROLL_MIN_WAIT_TIMEOUT_MS;
        let attempt = 0;
        let lastRenderRequestAt = initialRenderRequestAt;
        let lastWaitExtensionLogAt = 0;

        while (true) {
            if (!isTokenActive(token)) {
                return false;
            }

            const nowAtTop = Date.now();
            if (nowAtTop >= deadline) {
                if (
                    deadline < maxDeadline
                    && isTargetPageStillWarming(targetPageIndex)
                ) {
                    deadline = Math.min(maxDeadline, nowAtTop + SEARCH_SCROLL_WAIT_EXTENSION_MS);
                    if (nowAtTop - lastWaitExtensionLogAt >= SEARCH_SCROLL_WAIT_EXTENSION_MS) {
                        lastWaitExtensionLogAt = nowAtTop;
                        const warmupState = getTargetPageWarmupState(targetPageIndex);
                        logPdfNav(
                            `[PDF-NAV] waitForTextLayerAndScroll extending: pageIndex=${targetPageIndex}`
                            + ` untilMs=${deadline - startedAt}`
                            + ` renderPending=${warmupState.renderPending}`
                            + ` rendered=${warmupState.rendered}`
                            + ` textLayerReady=${warmupState.textLayerReady}`
                            + ` textLayerMarkedNotReady=${warmupState.textLayerMarkedNotReady}`
                            + ` textLayerRendering=${warmupState.textLayerRendering}`,
                        );
                    }
                } else {
                    break;
                }
            }

            if (!isStillTargetingPage(targetPageIndex)) {
                logPdfNav(
                    `[PDF-NAV] requestScrollToMatch aborting: match changed from pageIndex=${targetPageIndex} to ${deps.getCurrentSearchMatch()?.pageIndex ?? 'null'}`,
                );
                return false;
            }

            const warmupState = getTargetPageWarmupState(targetPageIndex);
            const now = Date.now();
            let renderRequested = false;
            if (now - lastRenderRequestAt >= SEARCH_RENDER_REQUEST_RETRY_MS) {
                deps.scheduleRenderForSinglePage(targetPageIndex + 1);
                lastRenderRequestAt = now;
                renderRequested = true;
            }
            const containerRoot = deps.getContainer();
            const pageContainer = containerRoot
                ? getPageContainer(containerRoot, targetPageIndex)
                : null;

            if (!isTargetPageDisplayReady(warmupState)) {
                logPdfNav(
                    `[PDF-NAV] waitForDisplayReadyAndScroll: pageIndex=${targetPageIndex} containerInDOM=${!!pageContainer} renderRequested=${renderRequested}`,
                    {
                        renderPending: warmupState.renderPending,
                        rendered: warmupState.rendered,
                        hasCanvas: warmupState.hasCanvas,
                        textLayerRendering: warmupState.textLayerRendering,
                        textLayerReady: warmupState.textLayerReady,
                        textLayerMarkedNotReady: warmupState.textLayerMarkedNotReady,
                    },
                );

                await delay(SEARCH_SCROLL_RETRY_DELAY_MS);
                continue;
            }

            attempt += 1;
            const matchScrolled = deps.scrollToCurrentMatch();
            logPdfNav(
                `[PDF-NAV] tryScrollNow attempt=${attempt} scrollToCurrentMatch=${matchScrolled}`,
            );
            if (matchScrolled) {
                return true;
            }

            logPdfNav(
                `[PDF-NAV] waitForTextLayerAndScroll: pageIndex=${targetPageIndex} containerInDOM=${!!pageContainer} renderRequested=${renderRequested}`,
                {
                    renderPending: warmupState.renderPending,
                    rendered: warmupState.rendered,
                    hasCanvas: warmupState.hasCanvas,
                    textLayerRendering: warmupState.textLayerRendering,
                    textLayerReady: warmupState.textLayerReady,
                    textLayerMarkedNotReady: warmupState.textLayerMarkedNotReady,
                },
            );

            await delay(SEARCH_SCROLL_RETRY_DELAY_MS);
        }

        return false;
    }

    function isStaleScrollRequest(
        requestId: number,
        matchPageIndex: number,
    ) {
        const currentMatch = deps.getCurrentSearchMatch();
        if (!currentMatch || currentMatch.pageIndex !== matchPageIndex) {
            logPdfNav(
                `[PDF-NAV] requestScrollToMatch stale requestId=${requestId} currentMatch=${currentMatch?.pageIndex ?? 'null'}`,
            );
            cancelActiveRequest(0);
            return true;
        }

        return false;
    }

    function scrollToCurrentMatchImmediately(matchPageIndex: number) {
        const warmupState = getTargetPageWarmupState(matchPageIndex);
        if (!isTargetPageDisplayReady(warmupState)) {
            logPdfNav(
                `[PDF-NAV] fast-path: target page=${matchPageIndex + 1} not display-ready`,
                {
                    renderPending: warmupState.renderPending,
                    rendered: warmupState.rendered,
                    hasCanvas: warmupState.hasCanvas,
                    textLayerRendering: warmupState.textLayerRendering,
                    textLayerReady: warmupState.textLayerReady,
                    textLayerMarkedNotReady: warmupState.textLayerMarkedNotReady,
                },
            );
            return false;
        }

        const didScroll = deps.scrollToCurrentMatch();
        if (didScroll) {
            logPdfNav('[PDF-NAV] fast-path: scrollToCurrentMatch succeeded immediately');
            deps.suppressSnap?.();
            cancelActiveRequest(SEARCH_SCROLL_SETTLE_MS);
        }

        return didScroll;
    }

    function beginTargetPageNavigation(matchPageIndex: number) {
        const pageNumber = matchPageIndex + 1;
        const markerRect = resolveCurrentMatchMarkerRect(
            deps.getCurrentSearchMatch(),
            matchPageIndex,
        );
        logPdfNav(
            `[PDF-NAV] revealing search target page=${pageNumber} before match-ready scroll`
            + ` marker=${markerRect ? 'true' : 'false'}`,
        );
        deps.beginSearchNavigation?.(pageNumber);
        if (markerRect) {
            deps.revealSearchNavigationTarget?.(pageNumber, { markerRect });
        } else {
            deps.revealSearchNavigationTarget?.(pageNumber);
        }
        deps.scheduleRenderForSinglePage(pageNumber);
        return Date.now();
    }

    function fallbackToPageScroll(matchPageIndex: number, requestId: number) {
        logPdfNav(
            `[PDF-NAV] requestScrollToMatch timed out pageIndex=${matchPageIndex} requestId=${requestId}`,
        );
        // Fallback keeps navigation deterministic even when highlight mapping is unavailable.
        deps.suppressSnap?.();
        const markerRect = resolveCurrentMatchMarkerRect(
            deps.getCurrentSearchMatch(),
            matchPageIndex,
        );
        deps.scrollToPage?.(matchPageIndex + 1, {
            preferExactDom: true,
            ...(markerRect ? { markerRect } : {}),
        });
        cancelActiveRequest(0);
    }

    async function finishDeferredSearchMatchScroll(
        token: IPendingRequestToken,
        requestId: number,
        matchPageIndex: number,
        initialRenderRequestAt: number,
    ) {
        const didScroll = await waitForMatchAndScroll(
            token,
            matchPageIndex,
            initialRenderRequestAt,
        );
        if (!isTokenActive(token)) {
            return;
        }

        if (didScroll) {
            deps.suppressSnap?.();
            cancelActiveRequest(SEARCH_SCROLL_SETTLE_MS);
            return;
        }

        fallbackToPageScroll(matchPageIndex, requestId);
    }

    async function processScrollToMatchRequest(
        token: IPendingRequestToken,
        requestId: number,
        matchPageIndex: number,
        initialRenderRequestAt: number,
    ) {
        if (!isTokenActive(token) || isStaleScrollRequest(requestId, matchPageIndex)) {
            return;
        }

        if (scrollToCurrentMatchImmediately(matchPageIndex)) {
            return;
        }

        await finishDeferredSearchMatchScroll(token, requestId, matchPageIndex, initialRenderRequestAt);
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

        const initialRenderRequestAt = beginTargetPageNavigation(matchPageIndex);

        void nextTick(async () => {
            try {
                await processScrollToMatchRequest(token, requestId, matchPageIndex, initialRenderRequestAt);
            } catch (error) {
                logPdfNav(
                    `[PDF-NAV] requestScrollToMatch failed requestId=${requestId}: ${getErrorMessage(error)}`,
                );
                cancelActiveRequest(0);
            }
        });
    }

    return {
        requestScrollToMatch,
        invalidatePendingRequests: () => {
            cancelActiveRequest(0);
        },
    };
}
