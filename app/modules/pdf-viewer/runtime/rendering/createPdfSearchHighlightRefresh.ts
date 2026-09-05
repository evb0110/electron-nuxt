import {
    pageNumberToPageIndex,
    parsePageNumber,
    type TPageNumber,
} from '@contracts/pageNumbers';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import type { IPageHighlightSignatureState } from '@app/modules/pdf-viewer/runtime/composables/pdf/pdfTextLayerRendererTypes';
import { measureDevPerf } from '@app/utils/devPerf';

const HIGHLIGHT_REFRESH_BUDGET_MS = 8;
const HIGHLIGHT_REFRESH_MAX_PAGES_PER_SLICE = 4;

interface IPdfSearchHighlightRefreshOptions {
    state: IPageHighlightSignatureState;
    getPageMatches: () => Map<number, IPdfPageMatches>;
    getCurrentMatch: () => IPdfSearchMatch | null;
    refreshPage: (container: HTMLElement, page: TPageNumber, matches: IPdfPageMatches | null, current: IPdfSearchMatch | null) => void;
}

export function createPdfSearchHighlightRefresh(deps: IPdfSearchHighlightRefreshOptions) {
    const pageHighlightState = deps.state;
    function getCurrentTime() {
        return typeof performance !== 'undefined'
            ? performance.now()
            : Date.now();
    }

    function runPendingHighlightRefresh(
        flushSearchHighlightRefresh: (root: HTMLElement | null, refreshVersion: number) => void,
    ) {
        const pendingRoot = pageHighlightState.pendingRoot;
        pageHighlightState.pendingRoot = null;
        if (pendingRoot) {
            flushSearchHighlightRefresh(pendingRoot, pageHighlightState.refreshVersion);
        }
    }

    function shouldPauseHighlightRefreshSlice(processedPages: number, sliceStartedAt: number) {
        const elapsed = getCurrentTime() - sliceStartedAt;
        return processedPages >= HIGHLIGHT_REFRESH_MAX_PAGES_PER_SLICE
            || elapsed >= HIGHLIGHT_REFRESH_BUDGET_MS;
    }

    function scheduleSearchHighlightRefresh(containerRoot: HTMLElement) {
        const scheduleContinuation = (callback: () => void) => {
            if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
                callback();
                return;
            }

            pageHighlightState.continuationRafId = window.requestAnimationFrame(() => {
                pageHighlightState.continuationRafId = 0;
                callback();
            });
        };

        const flushSearchHighlightRefresh = (
            root: HTMLElement | null,
            refreshVersion: number,
        ) => {
            if (!root || ('isConnected' in root && root.isConnected === false)) {
                return;
            }

            const pageContainers = Array.from(root.querySelectorAll<HTMLElement>('.page_container'));
            const searchMatchesValue = deps.getPageMatches();
            const currentMatchValue = deps.getCurrentMatch();
            let nextIndex = 0;

            const processSlice = () => {
                if (refreshVersion !== pageHighlightState.refreshVersion) {
                    runPendingHighlightRefresh(flushSearchHighlightRefresh);
                    return;
                }

                const sliceStartedAt = getCurrentTime();

                measureDevPerf('pdf:highlight-refresh-slice', () => {
                    let processedPages = 0;

                    while (nextIndex < pageContainers.length) {
                        const container = pageContainers[nextIndex];
                        nextIndex += 1;
                        processedPages += 1;
                        if (!container) {
                            continue;
                        }

                        const mountedPageNumber = parsePageNumber(Number.parseInt(container.dataset.page ?? '', 10));
                        if (mountedPageNumber === null) {
                            continue;
                        }

                        const pageIndex = pageNumberToPageIndex(mountedPageNumber);
                        const pageMatchData = searchMatchesValue.get(pageIndex) ?? null;
                        deps.refreshPage(
                            container,
                            mountedPageNumber,
                            pageMatchData,
                            currentMatchValue,
                        );

                        if (shouldPauseHighlightRefreshSlice(processedPages, sliceStartedAt)) {
                            break;
                        }
                    }
                }, {
                    thresholdMs: 8,
                    details: {
                        mountedPages: pageContainers.length,
                        remainingPages: Math.max(0, pageContainers.length - nextIndex),
                    },
                });

                if (nextIndex < pageContainers.length) {
                    scheduleContinuation(processSlice);
                    return;
                }

                if (pageHighlightState.pendingRoot && pageHighlightState.pendingRoot !== root) {
                    runPendingHighlightRefresh(flushSearchHighlightRefresh);
                }
            };

            processSlice();
        };

        pageHighlightState.pendingRoot = containerRoot;
        pageHighlightState.refreshVersion += 1;

        if (pageHighlightState.continuationRafId !== 0) {
            return;
        }

        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
            const root = pageHighlightState.pendingRoot;
            pageHighlightState.pendingRoot = null;
            flushSearchHighlightRefresh(root, pageHighlightState.refreshVersion);
            return;
        }

        if (pageHighlightState.rafId !== 0) {
            return;
        }

        pageHighlightState.rafId = window.requestAnimationFrame(() => {
            pageHighlightState.rafId = 0;

            const root = pageHighlightState.pendingRoot;
            pageHighlightState.pendingRoot = null;
            flushSearchHighlightRefresh(root, pageHighlightState.refreshVersion);
        });
    }

    function applySearchHighlightHandoff(containerRoot: HTMLElement, pages: number[]) {
        // Invalidate any sliced refresh that captured the previous selection.
        pageHighlightState.refreshVersion += 1;
        const matches = deps.getPageMatches();
        const current = deps.getCurrentMatch();
        for (const page of pages) {
            const pageNumber = parsePageNumber(page);
            if (pageNumber === null) {
                continue;
            }
            const container = containerRoot.querySelector<HTMLElement>(`.page_container[data-page="${page}"]`);
            if (container) {
                deps.refreshPage(container, pageNumber, matches.get(pageNumberToPageIndex(pageNumber)) ?? null, current);
            }
        }
    }

    return {
        scheduleSearchHighlightRefresh,
        applySearchHighlightHandoff,
    };
}
