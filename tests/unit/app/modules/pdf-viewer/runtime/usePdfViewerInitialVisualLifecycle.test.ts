import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePdfViewerInitialVisualLifecycle } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerInitialVisualLifecycle';
import type { IPdfCanvasDomCommit } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';

function createCommit(pageNumber: number): IPdfCanvasDomCommit {
    return {
        openSurfaceGeneration: 1,
        documentRevision: 'rev-1',
        renderVersion: 2,
        requestId: 3,
        pageNumber,
    };
}

describe('usePdfViewerInitialVisualLifecycle', () => {
    it('keeps canvas commit separate from the explicit viewport-ready handoff', () => {
        const renderedPageStateVersion = ref(0);
        const emitInitialVisualReady = vi.fn();
        const markDelayedSkeletonPageRendered = vi.fn();
        const syncManagedShapesAfterPageRendered = vi.fn();
        const lifecycle = usePdfViewerInitialVisualLifecycle({
            renderedPageStateVersion,
            emitInitialVisualReady,
            markDelayedSkeletonPageRendered,
            syncManagedShapesAfterPageRendered,
            isInitialVisualCanvasReady: pageNumber => pageNumber === 3,
        });

        lifecycle.setPendingInitialVisualReadyToken(11);
        lifecycle.handlePageCanvasMounted(createCommit(3));

        expect(renderedPageStateVersion.value).toBe(1);
        expect(syncManagedShapesAfterPageRendered).toHaveBeenCalledWith(3);
        expect(markDelayedSkeletonPageRendered).not.toHaveBeenCalled();
        expect(emitInitialVisualReady).not.toHaveBeenCalled();

        lifecycle.commitInitialVisualReady(3);

        expect(emitInitialVisualReady).toHaveBeenCalledOnce();
        expect(emitInitialVisualReady).toHaveBeenCalledWith({pageNumber: 3});
    });

    it('never infers initial readiness from a page-rendered notification', () => {
        const emitInitialVisualReady = vi.fn();
        const markDelayedSkeletonPageRendered = vi.fn();
        const lifecycle = usePdfViewerInitialVisualLifecycle({
            renderedPageStateVersion: ref(0),
            emitInitialVisualReady,
            markDelayedSkeletonPageRendered,
            syncManagedShapesAfterPageRendered: vi.fn(),
            isInitialVisualCanvasReady: () => true,
        });

        lifecycle.setPendingInitialVisualReadyToken(11);
        lifecycle.handlePageRendered(1);

        expect(markDelayedSkeletonPageRendered).toHaveBeenCalledWith(1);
        expect(emitInitialVisualReady).not.toHaveBeenCalled();
    });

    it('cancels an initial visual token before a canvas commit', () => {
        const emitInitialVisualReady = vi.fn();
        const lifecycle = usePdfViewerInitialVisualLifecycle({
            renderedPageStateVersion: ref(0),
            emitInitialVisualReady,
            markDelayedSkeletonPageRendered: vi.fn(),
            syncManagedShapesAfterPageRendered: vi.fn(),
            isInitialVisualCanvasReady: () => true,
        });

        lifecycle.setPendingInitialVisualReadyToken(11);
        lifecycle.cancelInitialVisualReady();
        lifecycle.handlePageCanvasMounted(createCommit(1));

        expect(emitInitialVisualReady).not.toHaveBeenCalled();
    });

    it('does not let an offscreen commit consume the pending visual token', () => {
        const emitInitialVisualReady = vi.fn();
        const lifecycle = usePdfViewerInitialVisualLifecycle({
            renderedPageStateVersion: ref(0),
            emitInitialVisualReady,
            markDelayedSkeletonPageRendered: vi.fn(),
            syncManagedShapesAfterPageRendered: vi.fn(),
            isInitialVisualCanvasReady: pageNumber => pageNumber === 1,
        });

        lifecycle.setPendingInitialVisualReadyToken(21);
        lifecycle.handlePageCanvasMounted(createCommit(2));
        expect(emitInitialVisualReady).not.toHaveBeenCalled();

        lifecycle.handlePageCanvasMounted(createCommit(1));
        lifecycle.commitInitialVisualReady(1);
        expect(emitInitialVisualReady).toHaveBeenCalledOnce();
        expect(emitInitialVisualReady).toHaveBeenCalledWith({pageNumber: 1});
    });

    it('keeps the token armed until an exact commit has a valid mounted canvas', () => {
        const emitInitialVisualReady = vi.fn();
        let canvasReady = false;
        const lifecycle = usePdfViewerInitialVisualLifecycle({
            renderedPageStateVersion: ref(0),
            emitInitialVisualReady,
            markDelayedSkeletonPageRendered: vi.fn(),
            syncManagedShapesAfterPageRendered: vi.fn(),
            isInitialVisualCanvasReady: () => canvasReady,
        });

        lifecycle.setPendingInitialVisualReadyToken(22);
        lifecycle.handlePageCanvasMounted(createCommit(1));
        expect(lifecycle.commitInitialVisualReady(1)).toBe(false);
        expect(emitInitialVisualReady).not.toHaveBeenCalled();

        canvasReady = true;
        lifecycle.handlePageCanvasMounted(createCommit(1));
        expect(lifecycle.commitInitialVisualReady(1)).toBe(true);
        expect(emitInitialVisualReady).toHaveBeenCalledOnce();
    });
});
