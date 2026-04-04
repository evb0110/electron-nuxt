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
import { usePdfViewerDocumentLifecycle } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerDocumentLifecycle';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
} from '@app/types/pdf';

function cast<T>(value: unknown): T {
    return value as T;
}

function flushLifecycleTasks() {
    return Promise.resolve()
        .then(() => nextTick())
        .then(() => Promise.resolve())
        .then(() => nextTick());
}

describe('usePdfViewerDocumentLifecycle', () => {
    it('re-applies the target page after the initial reload render before syncing viewport state', async () => {
        const callOrder: string[] = [];
        const currentPage = ref(200);
        const visibleRange = ref({
            start: 1,
            end: 1,
        });
        const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
        const numPages = ref(300);
        const viewerContainer = ref(cast<HTMLElement>({ querySelector: vi.fn(() => ({})) }));
        const ensurePageMetricsInRange = vi.fn(async () => false);
        const renderVisiblePages = vi.fn(async () => {
            callOrder.push('render');
        });
        const scrollToPage = vi.fn((pageNumber: number) => {
            callOrder.push(`scroll:${pageNumber}`);
        });
        const syncCurrentPageFromViewport = vi.fn(async () => {
            callOrder.push('sync');
        });
        const pinCurrentPageDuringRecovery = vi.fn();
        const beginVisualReloadTransition = vi.fn(() => 17);
        const endVisualReloadTransition = vi.fn();
        const emit = vi.fn((event: string, payload?: unknown) => {
            if (event === 'update:currentPage') {
                callOrder.push(`emit:${payload}`);
            }
        });

        const { scheduleLoadFromSource } = usePdfViewerDocumentLifecycle({
            viewerContainer,
            src: computed(() =>
                new Blob([new Uint8Array([1])], { type: 'application/pdf' }),
            ),
            zoom: computed(() => 1),
            zoomMode: computed(() => 'fit-width' as const),
            effectiveScale: ref(1),
            currentPage,
            visibleRange,
            basePageWidth: ref(612),
            basePageHeight: ref(792),
            annotationUiManager: shallowRef(null),
            annotationCommentsCache: ref([]),
            activeCommentStableKey: ref(null),
            pdfDocument,
            numPages,
            isLoading: ref(false),
            getRenderVersion: () => 1,
            loadPdf: vi.fn(async () => {
                pdfDocument.value = { numPages: numPages.value } as PDFDocumentProxy;
                return { version: 1 };
            }),
            ensurePageMetricsInRange,
            getPage: vi.fn(async () => ({}) as PDFPageProxy),
            renderVisiblePages,
            getVisibleRange: () => visibleRange.value,
            reRenderVisiblePagesAndSyncCurrentPage: vi.fn(async () => {}),
            syncCurrentPageFromViewport,
            applySearchHighlights: vi.fn(),
            updateVisibleRange: vi.fn(),
            scrollToPage,
            cleanupRenderedPages: vi.fn(),
            invalidateScaleCache: vi.fn(),
            resetScale: vi.fn(),
            resetInsets: vi.fn(),
            setupPagePlaceholders: vi.fn(),
            computeFitWidthScale: vi.fn(() => true),
            computeSkeletonInsets: vi.fn(async () => {}),
            invalidateRenderedPages: vi.fn(),
            consumePendingInvalidation: () => null,
            commentSync: {
                incrementSyncToken: vi.fn(),
                scheduleAnnotationCommentsSync: vi.fn(),
            },
            editor: {
                destroyAnnotationEditor: vi.fn(),
                initAnnotationEditor: vi.fn(),
            },
            pinCurrentPageDuringRecovery,
            suppressNextZoomRerender: vi.fn(),
            beginVisualReloadTransition,
            endVisualReloadTransition,
            emit,
        });

        scheduleLoadFromSource(true);
        await flushLifecycleTasks();

        expect(syncCurrentPageFromViewport).not.toHaveBeenCalled();
        expect(pinCurrentPageDuringRecovery).toHaveBeenCalledWith(200, {
            durationMs: 900,
            reason: 'reload-recovery',
        });
        expect(beginVisualReloadTransition).toHaveBeenCalledWith('reload-recovery');
        expect(endVisualReloadTransition).toHaveBeenCalledWith(17, 'warm-render-complete');
        expect(scrollToPage).toHaveBeenCalledTimes(3);
        expect(ensurePageMetricsInRange).toHaveBeenCalledWith(1, 200);
        expect(callOrder).toContain('emit:200');
        const firstScrollIndex = callOrder.indexOf('scroll:200');
        expect(firstScrollIndex).toBeGreaterThanOrEqual(0);
        expect(callOrder.slice(firstScrollIndex, firstScrollIndex + 5)).toEqual([
            'scroll:200',
            'render',
            'scroll:200',
            'emit:200',
            'render',
        ]);
    });

    it('waits for the restored custom zoom before the first reload render and skips scale reset', async () => {
        const callOrder: string[] = [];
        const zoom = ref(1);
        const fitWidthScale = ref(1.94);
        const currentPage = ref(200);
        const visibleRange = ref({
            start: 1,
            end: 1,
        });
        const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
        const numPages = ref(300);
        const viewerContainer = ref(cast<HTMLElement>({ querySelector: vi.fn(() => ({})) }));
        const invalidateScaleCache = vi.fn();
        const resetScale = vi.fn();
        const suppressNextZoomRerender = vi.fn();
        const renderVisiblePages = vi.fn(async () => {
            callOrder.push(`render:${zoom.value.toFixed(2)}`);
        });
        const computeFitWidthScale = vi.fn(() => {
            fitWidthScale.value = 1;
            return true;
        });
        const emit = vi.fn((event: string, payload?: unknown) => {
            if (event === 'update:zoom' && typeof payload === 'number') {
                callOrder.push(`emit-zoom:${payload.toFixed(2)}`);
                void Promise.resolve().then(() => {
                    zoom.value = payload;
                });
            }
        });

        const { scheduleLoadFromSource } = usePdfViewerDocumentLifecycle({
            viewerContainer,
            src: computed(() =>
                new Blob([new Uint8Array([1])], { type: 'application/pdf' }),
            ),
            zoom: computed(() => zoom.value),
            zoomMode: computed(() => 'custom' as const),
            effectiveScale: computed(() => zoom.value * fitWidthScale.value) as never,
            currentPage,
            visibleRange,
            basePageWidth: ref(612),
            basePageHeight: ref(792),
            annotationUiManager: shallowRef(null),
            annotationCommentsCache: ref([]),
            activeCommentStableKey: ref(null),
            pdfDocument,
            numPages,
            isLoading: ref(false),
            getRenderVersion: () => 1,
            loadPdf: vi.fn(async () => {
                pdfDocument.value = { numPages: numPages.value } as PDFDocumentProxy;
                return { version: 1 };
            }),
            ensurePageMetricsInRange: vi.fn(async () => false),
            getPage: vi.fn(async () => ({}) as PDFPageProxy),
            renderVisiblePages,
            getVisibleRange: () => visibleRange.value,
            reRenderVisiblePagesAndSyncCurrentPage: vi.fn(async () => {}),
            syncCurrentPageFromViewport: vi.fn(async () => {}),
            applySearchHighlights: vi.fn(),
            updateVisibleRange: vi.fn(),
            scrollToPage: vi.fn(),
            cleanupRenderedPages: vi.fn(),
            invalidateScaleCache,
            resetScale,
            resetInsets: vi.fn(),
            setupPagePlaceholders: vi.fn(() => {
                callOrder.push(`placeholders:${zoom.value.toFixed(2)}`);
            }),
            computeFitWidthScale,
            computeSkeletonInsets: vi.fn(async () => {}),
            invalidateRenderedPages: vi.fn(),
            consumePendingInvalidation: () => null,
            commentSync: {
                incrementSyncToken: vi.fn(),
                scheduleAnnotationCommentsSync: vi.fn(),
            },
            editor: {
                destroyAnnotationEditor: vi.fn(),
                initAnnotationEditor: vi.fn(),
            },
            pinCurrentPageDuringRecovery: vi.fn(),
            suppressNextZoomRerender,
            beginVisualReloadTransition: vi.fn(() => 17),
            endVisualReloadTransition: vi.fn(),
            emit,
        });

        scheduleLoadFromSource(true);
        await flushLifecycleTasks();
        await flushLifecycleTasks();

        expect(invalidateScaleCache).toHaveBeenCalledTimes(1);
        expect(resetScale).not.toHaveBeenCalled();
        expect(computeFitWidthScale).toHaveBeenCalledTimes(1);
        expect(suppressNextZoomRerender).toHaveBeenCalledWith(1.94);
        expect(callOrder.slice(0, 3)).toEqual([
            'emit-zoom:1.94',
            'placeholders:1.94',
            'render:1.94',
        ]);
    });
});
