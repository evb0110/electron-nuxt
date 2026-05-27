import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TPdfViewMode } from '@app/types/pdf';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfNav } from '@app/utils/pdfNavLog';

interface IPageRange {
    start: number;
    end: number;
}

interface IUsePdfViewerNavigationDiagnosticsOptions {
    currentPage: Ref<number>;
    visibleRange: Ref<IPageRange>;
    isLoading: Ref<boolean>;
    continuousScroll: ComputedRef<boolean>;
    fitMode: ComputedRef<string>;
    viewMode: ComputedRef<TPdfViewMode>;
    zoom: ComputedRef<number>;
    navigationAnchorWindow: ComputedRef<unknown>;
    virtualizedContinuousMode: ComputedRef<boolean>;
    virtualWindowStart: ComputedRef<number>;
    virtualWindowEnd: ComputedRef<number>;
    searchNavigationTargetPage: Ref<number | null>;
    searchNavigationState: Ref<string>;
    summarizeViewerStateForLog: () => unknown;
}

export function usePdfViewerNavigationDiagnostics(options: IUsePdfViewerNavigationDiagnosticsOptions) {
    watch(
        () => [
            !!options.navigationAnchorWindow.value,
            options.virtualWindowStart.value,
            options.virtualWindowEnd.value,
            options.currentPage.value,
            options.visibleRange.value.start,
            options.visibleRange.value.end,
            options.searchNavigationTargetPage.value,
            options.searchNavigationState.value,
        ] as const,
        ([
            anchored,
            start,
            end,
            page,
            visibleStart,
            visibleEnd,
            searchAnchorPage,
            searchNavigationState,
        ]) => {
            if (!options.virtualizedContinuousMode.value) {
                return;
            }
            if (searchNavigationState === 'idle') {
                return;
            }

            logPdfNav(
                `[PDF-NAV] virtualWindow anchored=${anchored}`
                + ` start=${start} end=${end} currentPage=${page}`
                + ` visibleRange=${visibleStart}-${visibleEnd}`
                + ` searchAnchor=${searchAnchorPage ?? 'none'}`
                + ` searchState=${searchNavigationState}`,
            );
        },
    );

    watch(options.currentPage, (next, previous) => {
        if (next === previous) {
            return;
        }
        BrowserLogger.warn('pdf-nav', `[viewer-current-page-ref] ${previous}->${next}`, {
            previous,
            next,
            isLoading: options.isLoading.value,
            continuousScroll: options.continuousScroll.value,
            fitMode: options.fitMode.value,
            viewMode: options.viewMode.value,
            zoom: options.zoom.value,
            visibleRange: {
                start: options.visibleRange.value.start,
                end: options.visibleRange.value.end,
            },
            viewer: options.summarizeViewerStateForLog(),
        });
    });

    watch(
        () => [
            options.visibleRange.value.start,
            options.visibleRange.value.end,
        ] as const,
        ([
            nextStart,
            nextEnd,
        ], [
            prevStart,
            prevEnd,
        ]) => {
            if (nextStart === prevStart && nextEnd === prevEnd) {
                return;
            }
            BrowserLogger.warn('pdf-nav', `[viewer-visible-range] ${prevStart}-${prevEnd} -> ${nextStart}-${nextEnd}`, {
                previous: {
                    start: prevStart,
                    end: prevEnd,
                },
                next: {
                    start: nextStart,
                    end: nextEnd,
                },
                currentPage: options.currentPage.value,
                isLoading: options.isLoading.value,
                continuousScroll: options.continuousScroll.value,
                viewer: options.summarizeViewerStateForLog(),
            });
        },
    );
}
