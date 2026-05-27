import type { Ref } from 'vue';
import { useViewerLoadSettle } from '@app/composables/pdf/useViewerLoadSettle';
import { usePdfViewerInitialVisualLifecycle } from '@app/modules/pdf-viewer-runtime/lifecycle/usePdfViewerInitialVisualLifecycle';
import type { usePdfViewerAnnotationRuntime } from '@app/modules/pdf-viewer-runtime/annotations/usePdfViewerAnnotationRuntime';
import type { usePdfSinglePageNavigationController } from '@app/modules/pdf-viewer-runtime/navigation/usePdfSinglePageNavigationController';

interface IUsePdfViewerLoadLifecycleControllerOptions {
    renderedPageStateVersion: Ref<number>;
    getAnnotationRuntime: () => ReturnType<typeof usePdfViewerAnnotationRuntime>;
    getSinglePageScroll: () => ReturnType<typeof usePdfSinglePageNavigationController>;
    emitInitialVisualPending: () => void;
    emitInitialVisualReady: (payload: {pageNumber: number;}) => void;
    markDelayedSkeletonPageRendered: (pageNumber: number) => void;
}

export function usePdfViewerLoadLifecycleController(options: IUsePdfViewerLoadLifecycleControllerOptions) {
    const {
        beginViewerLoadSettle,
        settleViewerLoadSettle,
        waitForViewerLoadSettled,
    } = useViewerLoadSettle();

    const {
        setPendingInitialVisualReadyToken,
        handleRenderedPageStateChanged,
        handlePageCanvasMounted,
        handlePageRendered,
    } = usePdfViewerInitialVisualLifecycle({
        renderedPageStateVersion: options.renderedPageStateVersion,
        emitInitialVisualReady: options.emitInitialVisualReady,
        markDelayedSkeletonPageRendered: options.markDelayedSkeletonPageRendered,
        syncManagedShapesAfterPageRendered: pageNumber =>
            options.getAnnotationRuntime().managedEmbeddedPdfShapes.syncAfterPageRendered(pageNumber),
        clearContinuousNavigationTargetForPage: pageNumber =>
            options.getSinglePageScroll().clearContinuousNavigationTargetForPage(pageNumber),
    });

    function onDocumentLoadStateChange(payload: {
        phase: 'started' | 'settled';
        token: number;
    }) {
        if (payload.phase === 'started') {
            setPendingInitialVisualReadyToken(payload.token);
            options.emitInitialVisualPending();
            beginViewerLoadSettle(payload.token);
            return;
        }

        options.getAnnotationRuntime().managedEmbeddedPdfShapes.settleViewerLoadSettledWithManagedShapes(
            payload.token,
            settleViewerLoadSettle,
        );
    }

    return {
        waitForViewerLoadSettled,
        handleRenderedPageStateChanged,
        handlePageCanvasMounted,
        handlePageRendered,
        onDocumentLoadStateChange,
    };
}
