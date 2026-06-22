import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import { usePdfViewerZoomRerenderQueue } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerZoomRerenderQueue';
import type { PDFDocumentProxy } from '@app/types/pdf';
import { cast } from '@tests/helpers/cast';

function createViewerMetrics() {
    return {
        scrollTop: 0,
        scrollLeft: 0,
        clientWidth: 800,
        clientHeight: 600,
        scrollWidth: 1200,
        scrollHeight: 1600,
    };
}

function createQueueHarness() {
    const scheduleEndResizeTransition = vi.fn();
    const queue = usePdfViewerZoomRerenderQueue({
        pdfDocument: shallowRef<PDFDocumentProxy | null>(cast<PDFDocumentProxy>({ fingerprint: 'doc' })),
        isLoading: ref(false),
        viewerContainer: ref(null),
        summarizeViewerMetricsForLog: () => ({}),
        reRenderVisiblePagesAndSyncCurrentPage: vi.fn(async () => {}),
        buildResizeAnchorContext: () => ({
            capturedAtMs: Date.now(),
            page: 2,
            transitionToken: 41,
            snapshot: null,
            visibleRange: {
                start: 2,
                end: 2,
            },
            viewerMetrics: createViewerMetrics(),
        }),
        scheduleEndResizeTransition,
        isZoomInteractionLocked: () => true,
    });
    return {
        queue,
        scheduleEndResizeTransition,
    };
}

describe('usePdfViewerZoomRerenderQueue', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('ends a deferred resize transition when the queue is reset', () => {
        vi.useFakeTimers();
        const {
            queue,
            scheduleEndResizeTransition,
        } = createQueueHarness();

        queue.enqueueZoomSync({
            source: 'zoom-change',
            resizeAnchor: {
                capturedAtMs: Date.now(),
                page: 1,
                transitionToken: 40,
                snapshot: null,
                visibleRange: {
                    start: 1,
                    end: 1,
                },
                viewerMetrics: createViewerMetrics(),
            },
        });
        queue.scheduleResizeAwareRerender('resize rerender', {
            source: 'resize-observer',
            resizeAnchor: {
                capturedAtMs: Date.now(),
                page: 2,
                transitionToken: 41,
                snapshot: null,
                visibleRange: {
                    start: 2,
                    end: 2,
                },
                viewerMetrics: createViewerMetrics(),
            },
        });

        queue.resetZoomRerenderQueueState('fit-mode-change');

        expect(scheduleEndResizeTransition).toHaveBeenCalledWith(
            41,
            'zoom-queue-reset:fit-mode-change',
            2,
        );
        queue.cleanupZoomRerenderQueue();
    });
});
