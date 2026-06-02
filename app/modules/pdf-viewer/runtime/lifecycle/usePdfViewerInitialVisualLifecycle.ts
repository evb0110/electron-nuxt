import type { Ref } from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';

interface IUsePdfViewerInitialVisualLifecycleOptions {
    renderedPageStateVersion: Ref<number>;
    emitInitialVisualReady: (payload: { pageNumber: number }) => void;
    markDelayedSkeletonPageRendered: (pageNumber: number) => void;
    syncManagedShapesAfterPageRendered: (pageNumber: number) => void;
    clearContinuousNavigationTargetForPage: (pageNumber: number) => void;
}

export function usePdfViewerInitialVisualLifecycle(options: IUsePdfViewerInitialVisualLifecycleOptions) {
    const {
        renderedPageStateVersion,
        emitInitialVisualReady,
        markDelayedSkeletonPageRendered,
        syncManagedShapesAfterPageRendered,
        clearContinuousNavigationTargetForPage,
    } = options;
    let pendingInitialVisualReadyToken: number | null = null;

    function setPendingInitialVisualReadyToken(token: number) {
        pendingInitialVisualReadyToken = token;
    }

    function handleRenderedPageStateChanged() {
        renderedPageStateVersion.value += 1;
    }

    function markInitialVisualReady(pageNumber: number) {
        if (pendingInitialVisualReadyToken === null) {
            return;
        }

        const token = pendingInitialVisualReadyToken;
        pendingInitialVisualReadyToken = null;
        emitInitialVisualReady({ pageNumber });
        BrowserLogger.debug('loader', 'PDF viewer initial visual ready', {
            token,
            pageNumber,
            source: 'page-render',
        });
    }

    function handlePageCanvasMounted(pageNumber: number) {
        renderedPageStateVersion.value += 1;
        syncManagedShapesAfterPageRendered(pageNumber);
    }

    function handlePageRendered(pageNumber: number) {
        markDelayedSkeletonPageRendered(pageNumber);
        clearContinuousNavigationTargetForPage(pageNumber);
        syncManagedShapesAfterPageRendered(pageNumber);
        markInitialVisualReady(pageNumber);
    }

    return {
        setPendingInitialVisualReadyToken,
        handleRenderedPageStateChanged,
        handlePageCanvasMounted,
        handlePageRendered,
    };
}
