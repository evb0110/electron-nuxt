import type { Ref } from 'vue';
import {
    countBy,
    maxBy,
} from 'es-toolkit/array';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getVisiblePageDebugSnapshot } from '@app/composables/pdf/pdfScrollVisibility';
import { summarizeViewerMetrics } from '@app/composables/pdf/pdfViewerMetrics';
import type {
    PDFDocumentProxy,
    IScrollSnapshot,
} from '@app/types/pdf';
import { isAnchoredCurrentPageSyncSource } from '@app/modules/pdf-viewer/runtime/rerenderStrategy';

const CURRENT_PAGE_SYNC_SAMPLE_COUNT = 3;
export { summarizeViewerMetrics };

export interface ICurrentPageSyncOptions {
    source?: string;
    stabilize?: boolean;
    resizeAnchor?: IResizeAnchorContext | null;
}

export interface IResizeAnchorContext {
    capturedAtMs: number;
    page: number;
    transitionToken: number;
    snapshot: IScrollSnapshot | null;
    visibleRange: {
        start: number;
        end: number;
    };
    viewerMetrics: ReturnType<typeof summarizeViewerMetrics>;
}

interface IUsePdfViewerCurrentPageSyncOptions {
    viewerContainer: Ref<HTMLElement | null>;
    numPages: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    currentPage: Ref<number>;
    pdfDocument: Ref<PDFDocumentProxy | null>;
    isLoading: Ref<boolean>;
    getMostVisiblePage: (
        container: HTMLElement | null,
        numPages: number,
    ) => number;
    updateCurrentPage: (
        container: HTMLElement | null,
        numPages: number,
    ) => number;
    emitCurrentPage: (page: number) => void;
}

export const usePdfViewerCurrentPageSync = (options: IUsePdfViewerCurrentPageSyncOptions) => {
    const {
        viewerContainer,
        numPages,
        visibleRange,
        currentPage,
        pdfDocument,
        isLoading,
        getMostVisiblePage,
        updateCurrentPage,
        emitCurrentPage,
    } = options;

    let currentPageSyncRunId = 0;
    let currentPageEmitEventId = 0;

    function summarizeViewerMetricsForLog(container: HTMLElement | null) {
        return summarizeViewerMetrics(container);
    }

    function summarizeVisiblePageSnapshotForLog(container: HTMLElement | null) {
        if (!container || numPages.value <= 0) {
            return null;
        }
        return getVisiblePageDebugSnapshot(container, numPages.value, 8).map((entry) => ({
            pageNumber: entry.pageNumber,
            visibleHeight: Math.round(entry.visibleHeight),
            pageTop: Math.round(entry.pageTop),
            pageBottom: Math.round(entry.pageBottom),
            pageHeight: Math.round(entry.pageHeight),
        }));
    }

    function buildSyncSummaryLine(
        source: string,
        previous: number,
        next: number,
        changed: boolean,
        fallbackToCurrent: boolean,
        samples: number[] | null,
    ) {
        const sampleText = samples && samples.length > 0
            ? samples.join(',')
            : 'none';
        return `[sync] source=${source} prev=${previous} next=${next}`
            + ` changed=${changed} fallback=${fallbackToCurrent}`
            + ` samples=${sampleText}`
            + ` range=${visibleRange.value.start}-${visibleRange.value.end}`;
    }

    function pickMostFrequentPage(pages: number[]) {
        const counts = countBy(pages, page => page);
        const winner = maxBy(pages, page => counts[page] ?? 0) ?? null;
        return {
            page: winner,
            count: winner === null ? 0 : (counts[winner] ?? 0),
        };
    }

    function emitCurrentPageIfChanged(
        page: number,
        source: string,
        samples: number[] | null,
        fallbackToCurrent: boolean,
    ) {
        const previous = currentPage.value;
        const changed = page !== previous;
        const hasSampleDrift = Boolean(samples && new Set(samples).size > 1);
        const shouldLog = changed || hasSampleDrift || fallbackToCurrent || source.includes('resize');
        const eventId = ++currentPageEmitEventId;

        if (shouldLog) {
            BrowserLogger.warn(
                'pdf-nav',
                `${buildSyncSummaryLine(source, previous, page, changed, fallbackToCurrent, samples)} eventId=${eventId}`,
                {
                    source,
                    eventId,
                    previousPage: previous,
                    nextPage: page,
                    changed,
                    fallbackToCurrent,
                    samples,
                    currentVisibleRange: {
                        start: visibleRange.value.start,
                        end: visibleRange.value.end,
                    },
                    viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                    visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(viewerContainer.value),
                    stack: (() => {
                        try {
                            return (new Error('viewport-current-page-sync'))
                                .stack
                                ?.split('\n')
                                .slice(1, 5)
                                .map(entry => entry.trim());
                        } catch {
                            return null;
                        }
                    })(),
                },
            );
        }

        if (!changed) {
            return;
        }
        currentPage.value = page;
        emitCurrentPage(page);
    }

    async function resolveStableCurrentPageFromViewport(syncRunId: number, source: string) {
        const container = viewerContainer.value;
        if (!container || numPages.value <= 0) {
            return null;
        }

        const samples: number[] = [];
        for (
            let sampleIndex = 0;
            sampleIndex < CURRENT_PAGE_SYNC_SAMPLE_COUNT;
            sampleIndex += 1
        ) {
            if (syncRunId !== currentPageSyncRunId) {
                return null;
            }
            const sampledPage = getMostVisiblePage(container, numPages.value);
            samples.push(sampledPage);
            BrowserLogger.warn(
                'pdf-nav',
                `[sync-sample] source=${source} run=${syncRunId}`
                + ` sample=${sampleIndex + 1}/${CURRENT_PAGE_SYNC_SAMPLE_COUNT}`
                + ` page=${sampledPage}`,
                {
                    source,
                    syncRunId,
                    sampleIndex,
                    sampledPage,
                    currentPage: currentPage.value,
                    visibleRange: {
                        start: visibleRange.value.start,
                        end: visibleRange.value.end,
                    },
                    viewer: summarizeViewerMetricsForLog(container),
                    visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(container),
                },
            );
            if (sampleIndex + 1 < CURRENT_PAGE_SYNC_SAMPLE_COUNT) {
                await nextTick();
                await waitForVisualFrames();
            }
        }

        const picked = pickMostFrequentPage(samples);
        if (picked.page === null) {
            return null;
        }

        if (picked.count <= 1) {
            return {
                page: currentPage.value,
                samples,
                fallbackToCurrent: true,
            };
        }

        return {
            page: picked.page,
            samples,
            fallbackToCurrent: false,
        };
    }

    async function syncCurrentPageFromViewport(options: ICurrentPageSyncOptions = {}) {
        if (!pdfDocument.value || isLoading.value || numPages.value <= 0) {
            return;
        }

        const source = options.source ?? 'default';
        if (options.resizeAnchor && isAnchoredCurrentPageSyncSource(source)) {
            BrowserLogger.warn(
                'pdf-nav',
                `[anchor] fixed current-page sync source=${source}`
                + ` page=${options.resizeAnchor.page}`
                + ` token=${options.resizeAnchor.transitionToken}`,
                {
                    source,
                    page: options.resizeAnchor.page,
                    transitionToken: options.resizeAnchor.transitionToken,
                    capturedAtMs: options.resizeAnchor.capturedAtMs,
                    capturedVisibleRange: options.resizeAnchor.visibleRange,
                    capturedViewerMetrics: options.resizeAnchor.viewerMetrics,
                    viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                    visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(viewerContainer.value),
                },
            );
            emitCurrentPageIfChanged(
                options.resizeAnchor.page,
                `${source}:anchor-fixed`,
                null,
                false,
            );
            return;
        }
        const syncRunId = ++currentPageSyncRunId;
        if (options.stabilize) {
            const stablePage = await resolveStableCurrentPageFromViewport(syncRunId, source);
            if (!stablePage || syncRunId !== currentPageSyncRunId) {
                return;
            }

            emitCurrentPageIfChanged(
                stablePage.page,
                source,
                stablePage.samples,
                stablePage.fallbackToCurrent,
            );
            return;
        }

        const page = updateCurrentPage(viewerContainer.value, numPages.value);
        emitCurrentPageIfChanged(page, source, null, false);
    }

    return {
        summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog,
        syncCurrentPageFromViewport,
    };
};
