import type { IDocumentPageMetrics } from '@app/utils/document-viewer/source/documentPageSource';
import { isDocumentPageSourceRasterCurrentForLayout } from '@app/modules/workspace-shell/viewers/documentPageSourcePresentation';
import {
    runDocumentViewerActivationPresentation,
    waitForDocumentViewerVisibleLayout,
} from '@app/utils/document-viewer/lifecycle/documentViewerActivationPresentation';

interface IRestorableDocumentPageState {
    lease: {release: () => void;} | null;
    unsubscribeInvalidation: (() => void) | null;
    widthPx: number;
}

interface IRestoreDocumentPageSourceActivePresentationOptions<TState extends IRestorableDocumentPageState> {
    beginPending: (pageNumber: number, state: TState) => void;
    getConnectedImage: (pageNumber: number, state: TState) => HTMLImageElement | null;
    getCurrentPage: () => number;
    getEffectiveZoom: () => number;
    getMetric: (pageNumber: number) => IDocumentPageMetrics | undefined;
    getPixelRatio: () => number;
    getState: (pageNumber: number) => TState | undefined;
    isCurrent: () => boolean;
    markReady: (pageNumber: number, state: TState) => void;
    measureViewport: () => void;
    readElement: () => HTMLElement | null;
    renderMountedPages: () => Promise<void>;
    readResidentPages: () => readonly number[];
    renderPage: (pageNumber: number) => Promise<void>;
}

export async function restoreDocumentPageSourceActivePresentation<TState extends IRestorableDocumentPageState>(
    options: IRestoreDocumentPageSourceActivePresentationOptions<TState>,
) {
    await runDocumentViewerActivationPresentation({
        isCurrent: options.isCurrent,
        waitForVisibleLayout: () => waitForDocumentViewerVisibleLayout(
            options.readElement,
            {isCurrent: options.isCurrent},
        ),
        measure: options.measureViewport,
        reconcile: async () => {
            const currentPage = options.getCurrentPage();
            const pages = new Set([
                currentPage,
                ...options.readResidentPages(),
            ]);
            for (const pageNumber of pages) {
                const state = options.getState(pageNumber);
                if (!state?.lease) {
                    continue;
                }
                const image = options.getConnectedImage(pageNumber, state);
                const metric = options.getMetric(pageNumber);
                if (
                    image?.complete
                    && image.naturalWidth > 0
                    && metric
                    && isDocumentPageSourceRasterCurrentForLayout(
                        state,
                        metric,
                        options.getEffectiveZoom(),
                        options.getPixelRatio(),
                    )
                ) {
                    options.markReady(pageNumber, state);
                    continue;
                }
                state.unsubscribeInvalidation?.();
                state.lease.release();
                state.unsubscribeInvalidation = null;
                state.lease = null;
                options.beginPending(pageNumber, state);
            }
            if (!options.isCurrent()) {
                return;
            }
            await options.renderPage(currentPage);
            if (options.isCurrent()) await options.renderMountedPages();
        },
    });
}
