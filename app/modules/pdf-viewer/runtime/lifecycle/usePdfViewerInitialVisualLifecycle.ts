import type { Ref } from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';

interface IUsePdfViewerInitialVisualLifecycleOptions {
    renderedPageStateVersion: Ref<number>;
    emitInitialVisualReady: (payload: { pageNumber: number }) => void;
    markDelayedSkeletonPageRendered: (pageNumber: number) => void;
    syncManagedShapesAfterPageRendered: (pageNumber: number) => void;
}

const initialVisualReadyPaintFrames = 2;
const initialVisualReadyFallbackMs = 120;

function waitForInitialVisualPaintOpportunity() {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
        return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
        let settled = false;
        let remainingFrames = initialVisualReadyPaintFrames;
        const timeoutId = setTimeout(finish, initialVisualReadyFallbackMs);

        function finish() {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeoutId);
            resolve();
        }

        function waitForNextFrame() {
            if (remainingFrames <= 0) {
                finish();
                return;
            }

            remainingFrames -= 1;
            window.requestAnimationFrame(waitForNextFrame);
        }

        waitForNextFrame();
    });
}

export const usePdfViewerInitialVisualLifecycle = (options: IUsePdfViewerInitialVisualLifecycleOptions) => {
    const {
        renderedPageStateVersion,
        emitInitialVisualReady,
        markDelayedSkeletonPageRendered,
        syncManagedShapesAfterPageRendered,
    } = options;
    let pendingInitialVisualReadyToken: number | null = null;
    let scheduledInitialVisualReadyToken: number | null = null;

    function setPendingInitialVisualReadyToken(token: number) {
        pendingInitialVisualReadyToken = token;
        scheduledInitialVisualReadyToken = null;
    }

    function cancelInitialVisualReady() {
        pendingInitialVisualReadyToken = null;
        scheduledInitialVisualReadyToken = null;
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
        scheduledInitialVisualReadyToken = token;

        // Page render completion can be reported before Chromium has composited
        // the new canvas. The document-open skeleton uses this signal as its
        // handoff point, so wait for paint opportunities to avoid a blank flash.
        void waitForInitialVisualPaintOpportunity().then(() => {
            if (scheduledInitialVisualReadyToken !== token) {
                return;
            }

            scheduledInitialVisualReadyToken = null;
            emitInitialVisualReady({ pageNumber });
            BrowserLogger.debug('loader', 'PDF viewer initial visual ready', {
                token,
                pageNumber,
                source: 'page-render',
            });
        });
    }

    function handlePageCanvasMounted(pageNumber: number) {
        renderedPageStateVersion.value += 1;
        syncManagedShapesAfterPageRendered(pageNumber);
    }

    function handlePageRendered(pageNumber: number) {
        markDelayedSkeletonPageRendered(pageNumber);
        syncManagedShapesAfterPageRendered(pageNumber);
        markInitialVisualReady(pageNumber);
    }

    return {
        setPendingInitialVisualReadyToken,
        cancelInitialVisualReady,
        handleRenderedPageStateChanged,
        handlePageCanvasMounted,
        handlePageRendered,
    };
};
