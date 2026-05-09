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
import type { IResizeAnchorContext } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerCurrentPageSync';
import type { PDFDocumentProxy } from '@app/types/pdf';

function cast<T>(value: unknown): T {
    return value as T;
}

function createResizeAnchor(page: number): IResizeAnchorContext {
    return {
        page,
        snapshot: null,
        capturedAtMs: Date.now(),
        transitionToken: 1,
        visibleRange: {
            start: page,
            end: page,
        },
        viewerMetrics: null,
    };
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
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(1)),
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
            beginResizeTransition: vi.fn(() => 1),
            consumeSuppressedZoomRerender,
        });

        zoom.value = 1.94;
        await nextTick();

        expect(consumeSuppressedZoomRerender).toHaveBeenCalledWith(1.94);
        expect(cancelInFlightPageRenders).not.toHaveBeenCalled();
        expect(enqueueZoomSync).not.toHaveBeenCalled();
    });

    it('uses the visible current page as a trusted toolbar zoom anchor', async () => {
        const zoom = ref(1);
        const pdfDocument = shallowRef<PDFDocumentProxy | null>(cast({}));
        const currentPage = ref(157);
        const visibleRange = ref({
            start: 156,
            end: 158,
        });
        const buildResizeAnchorContext = vi.fn(() => createResizeAnchor(157));
        const enqueueZoomSync = vi.fn();

        usePdfViewerRerenderCoordinator({
            viewerContainer: ref(null),
            pdfDocument,
            isLoading: ref(false),
            numPages: ref(348),
            currentPage,
            visibleRange,
            zoom: computed(() => zoom.value),
            fitMode: computed(() => 'width' as const),
            viewMode: computed(() => 'single' as const),
            isResizing: computed(() => false),
            continuousScroll: computed(() => false),
            getVisibleRange: () => visibleRange.value,
            reRenderAllVisiblePages: vi.fn(async () => {}),
            isPageRendered: vi.fn(() => true),
            summarizeViewerMetricsForLog: vi.fn(() => null),
            summarizeVisiblePageSnapshotForLog: vi.fn(() => null),
            syncCurrentPageFromViewport: vi.fn(async () => {}),
            markLowResZoomRerenderUsed: vi.fn(),
            buildResizeAnchorContext,
            scheduleEndResizeTransition: vi.fn(),
            enqueueZoomSync,
            scheduleResizeAwareRerender: vi.fn(),
            cancelInFlightPageRenders: vi.fn(),
            computeFitWidthScale: vi.fn(() => false),
            setupPagePlaceholders: vi.fn(),
            scrollToPage: vi.fn(),
            getMostVisiblePage: vi.fn(() => 157),
            resetContinuousScrollState: vi.fn(),
            resetZoomRerenderQueueState: vi.fn(),
            consumeZoomViewportAnchor: vi.fn(() => null),
            beginResizeTransition: vi.fn(() => 1),
            consumeSuppressedZoomRerender: vi.fn(() => false),
        });

        zoom.value = 1.43;
        await nextTick();

        expect(buildResizeAnchorContext).toHaveBeenCalledWith({
            anchorViewportX: null,
            anchorViewportY: null,
            preferredAnchorPage: 157,
            trustPreferredAnchorPage: true,
        });
        expect(enqueueZoomSync).toHaveBeenCalledWith(expect.objectContaining({
            source: 'zoom-change',
            stabilize: true,
            resizeAnchor: expect.objectContaining({ page: 157 }),
        }));
    });

    it('rerenders fit-width when the current page changes to a different width', async () => {
        const currentPage = ref(1);
        const computeFitWidthScale = vi.fn(() => true);
        const cancelInFlightPageRenders = vi.fn();
        const reRenderAllVisiblePages = vi.fn(async () => {});
        const syncCurrentPageFromViewport = vi.fn(async () => {});
        const buildResizeAnchorContext = vi.fn(() => createResizeAnchor(2));

        usePdfViewerRerenderCoordinator({
            viewerContainer: ref(null),
            pdfDocument: shallowRef<PDFDocumentProxy | null>(cast({})),
            isLoading: ref(false),
            numPages: ref(10),
            currentPage,
            visibleRange: ref({
                start: 1,
                end: 2,
            }),
            zoom: computed(() => 1),
            fitMode: computed(() => 'width' as const),
            viewMode: computed(() => 'single' as const),
            isResizing: computed(() => false),
            continuousScroll: computed(() => true),
            getVisibleRange: () => ({
                start: 1,
                end: 2,
            }),
            reRenderAllVisiblePages,
            isPageRendered: vi.fn(() => true),
            summarizeViewerMetricsForLog: vi.fn(() => null),
            summarizeVisiblePageSnapshotForLog: vi.fn(() => null),
            syncCurrentPageFromViewport,
            markLowResZoomRerenderUsed: vi.fn(),
            buildResizeAnchorContext,
            scheduleEndResizeTransition: vi.fn(),
            enqueueZoomSync: vi.fn(),
            scheduleResizeAwareRerender: vi.fn(),
            cancelInFlightPageRenders,
            computeFitWidthScale,
            setupPagePlaceholders: vi.fn(),
            scrollToPage: vi.fn(),
            getMostVisiblePage: vi.fn(() => 2),
            resetContinuousScrollState: vi.fn(),
            resetZoomRerenderQueueState: vi.fn(),
            consumeZoomViewportAnchor: vi.fn(() => null),
            beginResizeTransition: vi.fn(() => 1),
            consumeSuppressedZoomRerender: vi.fn(() => false),
        });

        currentPage.value = 2;
        await nextTick();
        await nextTick();

        expect(computeFitWidthScale).toHaveBeenCalled();
        expect(buildResizeAnchorContext).toHaveBeenCalledWith({
            preferredAnchorPage: 2,
            trustPreferredAnchorPage: true,
        });
        expect(cancelInFlightPageRenders).toHaveBeenCalled();
        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({ rerenderSource: 'fit-width-current-page' }),
        );
        expect(syncCurrentPageFromViewport).toHaveBeenCalledWith(
            expect.objectContaining({ source: 'fit-width-current-page' }),
        );
    });

    it('renders zoom-change frames through the low-resolution settle path', async () => {
        const reRenderAllVisiblePages = vi.fn(async () => {});
        const markLowResZoomRerenderUsed = vi.fn();

        const {reRenderVisiblePagesAndSyncCurrentPage} = usePdfViewerRerenderCoordinator({
            viewerContainer: ref(null),
            pdfDocument: shallowRef<PDFDocumentProxy | null>(cast({})),
            isLoading: ref(false),
            numPages: ref(348),
            currentPage: ref(157),
            visibleRange: ref({
                start: 157,
                end: 157,
            }),
            zoom: computed(() => 1),
            fitMode: computed(() => 'width' as const),
            viewMode: computed(() => 'single' as const),
            isResizing: computed(() => false),
            continuousScroll: computed(() => false),
            getVisibleRange: () => ({
                start: 157,
                end: 157,
            }),
            reRenderAllVisiblePages,
            isPageRendered: vi.fn(() => true),
            summarizeViewerMetricsForLog: vi.fn(() => null),
            summarizeVisiblePageSnapshotForLog: vi.fn(() => null),
            syncCurrentPageFromViewport: vi.fn(async () => {}),
            markLowResZoomRerenderUsed,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(157)),
            scheduleEndResizeTransition: vi.fn(),
            enqueueZoomSync: vi.fn(),
            scheduleResizeAwareRerender: vi.fn(),
            cancelInFlightPageRenders: vi.fn(),
            computeFitWidthScale: vi.fn(() => false),
            setupPagePlaceholders: vi.fn(),
            scrollToPage: vi.fn(),
            getMostVisiblePage: vi.fn(() => 157),
            resetContinuousScrollState: vi.fn(),
            resetZoomRerenderQueueState: vi.fn(),
            consumeZoomViewportAnchor: vi.fn(() => null),
            beginResizeTransition: vi.fn(() => 1),
            consumeSuppressedZoomRerender: vi.fn(() => false),
        });

        await reRenderVisiblePagesAndSyncCurrentPage({
            source: 'zoom-change',
            stabilize: true,
            resizeAnchor: createResizeAnchor(157),
        });

        expect(markLowResZoomRerenderUsed).toHaveBeenCalled();
        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                rerenderSource: 'zoom-change',
                renderBufferOverride: 0,
                maxCanvasPixelsOverride: 14_000_000,
            }),
        );
    });
});
