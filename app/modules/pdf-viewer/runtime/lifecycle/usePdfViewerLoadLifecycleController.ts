import type { Ref } from 'vue';
import { useViewerLoadSettle } from '@app/modules/pdf-viewer/runtime/composables/pdf/useViewerLoadSettle';
import { usePdfViewerInitialVisualLifecycle } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerInitialVisualLifecycle';
import type { usePdfViewerAnnotationRuntime } from '@app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntime';

interface IUsePdfViewerLoadLifecycleControllerOptions {
    renderedPageStateVersion: Ref<number>;
    getAnnotationRuntime: () => ReturnType<typeof usePdfViewerAnnotationRuntime>;
    emitInitialVisualPending: (token: number) => void;
    emitInitialVisualReady: (payload: {pageNumber: number;}) => void;
    markDelayedSkeletonPageRendered: (pageNumber: number) => void;
    isInitialVisualCanvasReady: (pageNumber: number) => boolean;
}

export const usePdfViewerLoadLifecycleController = (options: IUsePdfViewerLoadLifecycleControllerOptions) => {
    const {
        beginViewerLoadSettle,
        settleViewerLoadSettle,
        waitForViewerLoadSettled,
    } = useViewerLoadSettle();

    const {
        setPendingInitialVisualReadyToken,
        cancelInitialVisualReady,
        canCommitInitialVisualReady,
        handleRenderedPageStateChanged,
        handlePageCanvasMounted,
        commitInitialVisualReady,
        handlePageRendered,
    } = usePdfViewerInitialVisualLifecycle({
        renderedPageStateVersion: options.renderedPageStateVersion,
        emitInitialVisualReady: options.emitInitialVisualReady,
        markDelayedSkeletonPageRendered: options.markDelayedSkeletonPageRendered,
        syncManagedShapesAfterPageRendered: pageNumber =>
            options.getAnnotationRuntime().managedEmbeddedPdfShapes.syncAfterPageRendered(pageNumber),
        isInitialVisualCanvasReady: options.isInitialVisualCanvasReady,
    });

    function onDocumentLoadStateChange(payload: {
        phase: 'started' | 'settled';
        token: number;
    }) {
        if (payload.phase === 'started') {
            setPendingInitialVisualReadyToken(payload.token);
            options.emitInitialVisualPending(payload.token);
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
        cancelInitialVisualReady,
        canCommitInitialVisualReady,
        handleRenderedPageStateChanged,
        handlePageCanvasMounted,
        commitInitialVisualReady,
        handlePageRendered,
        onDocumentLoadStateChange,
    };
};
