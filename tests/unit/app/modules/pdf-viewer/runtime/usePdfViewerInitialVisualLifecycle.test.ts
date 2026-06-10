import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePdfViewerInitialVisualLifecycle } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerInitialVisualLifecycle';

let restoreWindow: (() => void) | null = null;

function installRequestAnimationFrameQueue() {
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const callbacks: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
    });

    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        writable: true,
        value: { requestAnimationFrame },
    });

    restoreWindow = () => {
        if (originalWindowDescriptor) {
            Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
            return;
        }

        Reflect.deleteProperty(globalThis, 'window');
    };

    return {
        requestAnimationFrame,
        async runNextFrame() {
            const callback = callbacks.shift();
            expect(callback).toBeTypeOf('function');
            callback?.(performance.now());
            await Promise.resolve();
            await Promise.resolve();
        },
    };
}

afterEach(() => {
    restoreWindow?.();
    restoreWindow = null;
});

describe('usePdfViewerInitialVisualLifecycle', () => {
    it('keeps delayed skeletons visible until the full page render finalizes', async () => {
        const frameQueue = installRequestAnimationFrameQueue();
        const renderedPageStateVersion = ref(0);
        const emitInitialVisualReady = vi.fn();
        const markDelayedSkeletonPageRendered = vi.fn();
        const syncManagedShapesAfterPageRendered = vi.fn();

        const lifecycle = usePdfViewerInitialVisualLifecycle({
            renderedPageStateVersion,
            emitInitialVisualReady,
            markDelayedSkeletonPageRendered,
            syncManagedShapesAfterPageRendered,
        });

        lifecycle.setPendingInitialVisualReadyToken(11);
        lifecycle.handlePageCanvasMounted(3);

        expect(renderedPageStateVersion.value).toBe(1);
        expect(syncManagedShapesAfterPageRendered).toHaveBeenCalledWith(3);
        expect(markDelayedSkeletonPageRendered).not.toHaveBeenCalled();
        expect(emitInitialVisualReady).not.toHaveBeenCalled();

        lifecycle.handlePageRendered(3);

        expect(markDelayedSkeletonPageRendered).toHaveBeenCalledWith(3);
        expect(syncManagedShapesAfterPageRendered).toHaveBeenCalledTimes(2);
        expect(emitInitialVisualReady).not.toHaveBeenCalled();
        expect(frameQueue.requestAnimationFrame).toHaveBeenCalledTimes(1);

        await frameQueue.runNextFrame();
        expect(emitInitialVisualReady).not.toHaveBeenCalled();
        expect(frameQueue.requestAnimationFrame).toHaveBeenCalledTimes(2);

        await frameQueue.runNextFrame();
        expect(emitInitialVisualReady).toHaveBeenCalledOnce();
        expect(emitInitialVisualReady).toHaveBeenCalledWith({ pageNumber: 3 });
    });

    it('ignores a stale paint-ready callback when a new document starts opening', async () => {
        const frameQueue = installRequestAnimationFrameQueue();
        const renderedPageStateVersion = ref(0);
        const emitInitialVisualReady = vi.fn();
        const markDelayedSkeletonPageRendered = vi.fn();
        const syncManagedShapesAfterPageRendered = vi.fn();

        const lifecycle = usePdfViewerInitialVisualLifecycle({
            renderedPageStateVersion,
            emitInitialVisualReady,
            markDelayedSkeletonPageRendered,
            syncManagedShapesAfterPageRendered,
        });

        lifecycle.setPendingInitialVisualReadyToken(11);
        lifecycle.handlePageRendered(1);
        lifecycle.setPendingInitialVisualReadyToken(12);

        await frameQueue.runNextFrame();
        await frameQueue.runNextFrame();

        expect(emitInitialVisualReady).not.toHaveBeenCalled();

        lifecycle.handlePageRendered(2);
        await frameQueue.runNextFrame();
        await frameQueue.runNextFrame();

        expect(emitInitialVisualReady).toHaveBeenCalledOnce();
        expect(emitInitialVisualReady).toHaveBeenCalledWith({ pageNumber: 2 });
    });
});
