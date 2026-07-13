import type { Ref } from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import { markStartupMetricOnce } from '@app/utils/startupMetrics';
import type { IPdfCanvasDomCommit } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';

interface IUsePdfViewerInitialVisualLifecycleOptions {
    renderedPageStateVersion: Ref<number>;
    emitInitialVisualReady: (payload: { pageNumber: number }) => void;
    markDelayedSkeletonPageRendered: (pageNumber: number) => void;
    syncManagedShapesAfterPageRendered: (pageNumber: number) => void;
    isInitialVisualCanvasReady: (pageNumber: number) => boolean;
}

export const usePdfViewerInitialVisualLifecycle = (options: IUsePdfViewerInitialVisualLifecycleOptions) => {
    const {
        renderedPageStateVersion,
        emitInitialVisualReady,
        markDelayedSkeletonPageRendered,
        syncManagedShapesAfterPageRendered,
        isInitialVisualCanvasReady,
    } = options;
    let pendingInitialVisualReadyToken: number | null = null;

    function setPendingInitialVisualReadyToken(token: number) {
        pendingInitialVisualReadyToken = token;
    }

    function cancelInitialVisualReady() {
        pendingInitialVisualReadyToken = null;
    }

    function handleRenderedPageStateChanged() {
        renderedPageStateVersion.value += 1;
    }

    function markInitialVisualReady(pageNumber: number) {
        if (
            pendingInitialVisualReadyToken === null
            || !isInitialVisualCanvasReady(pageNumber)
        ) {
            return false;
        }

        const token = pendingInitialVisualReadyToken;
        pendingInitialVisualReadyToken = null;
        markStartupMetricOnce('evb:first-page-painted');
        emitInitialVisualReady({ pageNumber });
        BrowserLogger.debug('loader', 'PDF viewer initial visual ready', {
            token,
            pageNumber,
            source: 'canvas-dom-commit',
        });
        return true;
    }

    function handlePageCanvasMounted(commit: IPdfCanvasDomCommit) {
        const pageNumber = commit.pageNumber;
        renderedPageStateVersion.value += 1;
        syncManagedShapesAfterPageRendered(pageNumber);
    }

    function commitInitialVisualReady(pageNumber: number) {
        return markInitialVisualReady(pageNumber);
    }

    function handlePageRendered(pageNumber: number) {
        markDelayedSkeletonPageRendered(pageNumber);
        syncManagedShapesAfterPageRendered(pageNumber);
    }

    return {
        setPendingInitialVisualReadyToken,
        cancelInitialVisualReady,
        handleRenderedPageStateChanged,
        handlePageCanvasMounted,
        commitInitialVisualReady,
        handlePageRendered,
    };
};
