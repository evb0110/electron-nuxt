import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePdfViewerInitialVisualLifecycle } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerInitialVisualLifecycle';

describe('usePdfViewerInitialVisualLifecycle', () => {
    it('keeps delayed skeletons visible until the full page render finalizes', () => {
        const renderedPageStateVersion = ref(0);
        const emitInitialVisualReady = vi.fn();
        const markDelayedSkeletonPageRendered = vi.fn();
        const syncManagedShapesAfterPageRendered = vi.fn();
        const clearContinuousNavigationTargetForPage = vi.fn();

        const lifecycle = usePdfViewerInitialVisualLifecycle({
            renderedPageStateVersion,
            emitInitialVisualReady,
            markDelayedSkeletonPageRendered,
            syncManagedShapesAfterPageRendered,
            clearContinuousNavigationTargetForPage,
        });

        lifecycle.setPendingInitialVisualReadyToken(11);
        lifecycle.handlePageCanvasMounted(3);

        expect(renderedPageStateVersion.value).toBe(1);
        expect(syncManagedShapesAfterPageRendered).toHaveBeenCalledWith(3);
        expect(markDelayedSkeletonPageRendered).not.toHaveBeenCalled();
        expect(emitInitialVisualReady).not.toHaveBeenCalled();

        lifecycle.handlePageRendered(3);

        expect(markDelayedSkeletonPageRendered).toHaveBeenCalledWith(3);
        expect(clearContinuousNavigationTargetForPage).toHaveBeenCalledWith(3);
        expect(syncManagedShapesAfterPageRendered).toHaveBeenCalledTimes(2);
        expect(emitInitialVisualReady).toHaveBeenCalledOnce();
        expect(emitInitialVisualReady).toHaveBeenCalledWith({ pageNumber: 3 });
    });
});
