import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TPdfViewMode } from '@app/types/pdfContracts';
import type { IPageRange } from '@app/types/pdfUi';
import type { IPdfRasterSchedulerSnapshot } from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import { logPdfNav } from '@app/utils/logPdfNav';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';


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
    getRasterSchedulerSnapshot: () => IPdfRasterSchedulerSnapshot | null;
    summarizeViewerStateForLog: () => unknown;
}

type TNavigationDiagnosticSnapshot = readonly [boolean, number, number, number, number, number, number | null, string];
type TViewerDiagnosticSnapshot = readonly [number, number, number];

export const usePdfViewerNavigationDiagnostics = (options: IUsePdfViewerNavigationDiagnosticsOptions) => {
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
        (snapshot: TNavigationDiagnosticSnapshot) => {
            const anchored = snapshot[0];
            const start = snapshot[1];
            const end = snapshot[2];
            const page = snapshot[3];
            const visibleStart = snapshot[4];
            const visibleEnd = snapshot[5];
            const searchAnchorPage = snapshot[6];
            const searchNavigationState = snapshot[7];

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

    watch(
        () => [
            options.currentPage.value,
            options.visibleRange.value.start,
            options.visibleRange.value.end,
        ] as const,
        (snapshot: TViewerDiagnosticSnapshot) => {
            logPdfRenderTrace('raster-scheduler-snapshot', () => ({
                currentPage: snapshot[0],
                visibleRange: {
                    start: snapshot[1],
                    end: snapshot[2],
                },
                isLoading: options.isLoading.value,
                continuousScroll: options.continuousScroll.value,
                fitMode: options.fitMode.value,
                viewMode: options.viewMode.value,
                zoom: options.zoom.value,
                scheduler: options.getRasterSchedulerSnapshot(),
                viewer: options.summarizeViewerStateForLog(),
            }));
        },
    );
};
