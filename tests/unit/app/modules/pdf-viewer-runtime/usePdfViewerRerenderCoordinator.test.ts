import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import { usePdfViewerRerenderCoordinator } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerRerenderCoordinator';
import type { PDFDocumentProxy } from '@app/types/pdf';

function cast<T>(value: unknown): T {
    return value as T;
}

describe('usePdfViewerRerenderCoordinator', () => {
    it('skips scheduling a zoom rerender when the zoom change was already handled by reload recovery', async () => {
        const zoom = ref(1);
        const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
        const consumeSuppressedZoomRerender = vi.fn(() => true);
        const enqueueZoomSync = vi.fn();
        const cancelInFlightPageRenders = vi.fn();

        pdfDocument.value = cast<PDFDocumentProxy>({});

        usePdfViewerRerenderCoordinator({
            viewerContainer: ref(null),
            pdfDocument,
            isLoading: ref(false),
            numPages: ref(10),
            currentPage: ref(1),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            zoom: computed(() => zoom.value),
            fitMode: computed(() => 'width' as const),
            viewMode: computed(() => 'single' as const),
            isResizing: computed(() => false),
            continuousScroll: computed(() => false),
            getVisibleRange: () => ({
                start: 1,
                end: 1,
            }),
            reRenderAllVisiblePages: vi.fn(async () => {}),
            isPageRendered: vi.fn(() => true),
            summarizeViewerMetricsForLog: vi.fn(() => null),
            summarizeVisiblePageSnapshotForLog: vi.fn(() => null),
            syncCurrentPageFromViewport: vi.fn(async () => {}),
            markLowResZoomRerenderUsed: vi.fn(),
            buildResizeAnchorContext: vi.fn(() => cast({
                page: 1,
                snapshot: null,
                capturedAtMs: Date.now(),
                containerRect: null,
                scrollLeft: 0,
                scrollTop: 0,
                offsetWithinPagePx: 0,
                offsetWithinPageRatio: null,
                horizontalOffsetWithinPagePx: 0,
                horizontalOffsetWithinPageRatio: null,
                transitionToken: 1,
                visibleRange: {
                    start: 1,
                    end: 1,
                },
                viewerMetrics: null,
            })),
            scheduleEndResizeTransition: vi.fn(),
            enqueueZoomSync,
            scheduleResizeAwareRerender: vi.fn(),
            cancelInFlightPageRenders,
            computeFitWidthScale: vi.fn(() => false),
            setupPagePlaceholders: vi.fn(),
            scrollToPage: vi.fn(),
            getMostVisiblePage: vi.fn(() => 1),
            resetContinuousScrollState: vi.fn(),
            resetZoomRerenderQueueState: vi.fn(),
            consumeZoomViewportAnchor: vi.fn(() => null),
            isZoomGestureSessionLocked: vi.fn(() => false),
            beginResizeTransition: vi.fn(() => 1),
            consumeSuppressedZoomRerender,
        });

        zoom.value = 1.94;
        await nextTick();

        expect(consumeSuppressedZoomRerender).toHaveBeenCalledWith(1.94);
        expect(cancelInFlightPageRenders).not.toHaveBeenCalled();
        expect(enqueueZoomSync).not.toHaveBeenCalled();
    });
});
