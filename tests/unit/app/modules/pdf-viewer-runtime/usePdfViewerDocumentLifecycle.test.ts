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
    it('reconciles fresh document opens to page one even when current page is already one', async () => {
        const callOrder: string[] = [];
        const currentPage = ref(1);
        const visibleRange = ref({
            start: 1,
            end: 1,
        });
        const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
        const numPages = ref(392);
        const viewerContainer = ref(cast<HTMLElement>({ querySelector: vi.fn(() => ({})) }));
        const scrollToPage = vi.fn((pageNumber: number) => {
            callOrder.push(`scroll:${pageNumber}`);
        });
        const renderVisiblePages = vi.fn(async () => {
            callOrder.push('render');
        });
        const updateVisibleRange = vi.fn(() => {
            callOrder.push('update-visible-range');
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
            ensurePageMetricsInRange: vi.fn(async () => false),
            getPage: vi.fn(async () => ({}) as PDFPageProxy),
            renderVisiblePages,
            getVisibleRange: () => visibleRange.value,
            reRenderVisiblePagesAndSyncCurrentPage: vi.fn(async () => {}),
            syncCurrentPageFromViewport: vi.fn(async () => {
                callOrder.push('sync');
            }),
            applySearchHighlights: vi.fn(),
            updateVisibleRange,
            scrollToPage,
            cleanupRenderedPages: vi.fn(),
            invalidateScaleCache: vi.fn(),
            resetScale: vi.fn(),
            resetInsets: vi.fn(),
            setupPagePlaceholders: vi.fn(() => {
                callOrder.push('setup-placeholders');
            }),
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
            pinCurrentPageDuringRecovery: vi.fn(),
            suppressNextZoomRerender: vi.fn(),
            beginVisualReloadTransition: vi.fn(() => 17),
            endVisualReloadTransition: vi.fn(),
            emit: vi.fn(),
        });

        scheduleLoadFromSource();
        await flushLifecycleTasks();

        expect(scrollToPage).toHaveBeenCalledWith(1);
        expect(callOrder.indexOf('scroll:1')).toBeGreaterThan(callOrder.indexOf('setup-placeholders'));
        expect(callOrder.indexOf('scroll:1')).toBeLessThan(callOrder.indexOf('render'));
    });

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
            effectiveScale: computed(() => zoom.value * fitWidthScale.value),
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

    it('preserves fit-mode scale during same-document reloads', async () => {
        const currentPage = ref(3);
        const visibleRange = ref({
            start: 3,
            end: 3,
        });
        const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
        const numPages = ref(10);
        const viewerContainer = ref(cast<HTMLElement>({ querySelector: vi.fn(() => ({})) }));
        const invalidateScaleCache = vi.fn();
        const resetScale = vi.fn();

        const { scheduleLoadFromSource } = usePdfViewerDocumentLifecycle({
            viewerContainer,
            src: computed(() =>
                new Blob([new Uint8Array([1])], { type: 'application/pdf' }),
            ),
            zoom: computed(() => 1),
            zoomMode: computed(() => 'fit-width' as const),
            effectiveScale: ref(1.18),
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
            renderVisiblePages: vi.fn(async () => {}),
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
            pinCurrentPageDuringRecovery: vi.fn(),
            suppressNextZoomRerender: vi.fn(),
            beginVisualReloadTransition: vi.fn(() => 17),
            endVisualReloadTransition: vi.fn(),
            emit: vi.fn(),
        });

        scheduleLoadFromSource(true);
        await flushLifecycleTasks();

        expect(invalidateScaleCache).toHaveBeenCalledTimes(1);
        expect(resetScale).not.toHaveBeenCalled();
    });

    it('preserves mounted pages while rebasing a same-document reload', async () => {
        const currentPage = ref(3);
        const visibleRange = ref({
            start: 3,
            end: 3,
        });
        const pdfDocument = shallowRef<PDFDocumentProxy | null>({ numPages: 10 } as PDFDocumentProxy);
        const numPages = ref(10);
        const cleanupRenderedPages = vi.fn();
        const destroyAnnotationEditor = vi.fn();
        const renderVisiblePages = vi.fn(async () => {});
        const updateVisibleRange = vi.fn();
        const scrollToPage = vi.fn();
        const ensurePageMetricsInRange = vi.fn(async () => false);
        const setupPagePlaceholders = vi.fn();
        const computeFitWidthScale = vi.fn(() => true);
        const computeSkeletonInsets = vi.fn(async () => {});
        const getPage = vi.fn(async () => ({}) as PDFPageProxy);
        const endVisualReloadTransition = vi.fn();
        const viewerContainer = cast<HTMLElement>({
            scrollLeft: 45,
            scrollTop: 1234,
            querySelector: vi.fn(() => ({})),
        });
        const loadPdf = vi.fn(async () => {
            viewerContainer.scrollLeft = 88;
            viewerContainer.scrollTop = 999;
            pdfDocument.value = { numPages: numPages.value } as PDFDocumentProxy;
            return { version: 2 };
        });

        const {
            preserveNextSourceReloadVisibleContent,
            scheduleLoadFromSource,
        } = usePdfViewerDocumentLifecycle({
            viewerContainer: ref(viewerContainer),
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
            getRenderVersion: () => 2,
            loadPdf,
            ensurePageMetricsInRange,
            getPage,
            renderVisiblePages,
            getVisibleRange: () => visibleRange.value,
            reRenderVisiblePagesAndSyncCurrentPage: vi.fn(async () => {}),
            syncCurrentPageFromViewport: vi.fn(async () => {}),
            applySearchHighlights: vi.fn(),
            updateVisibleRange,
            scrollToPage,
            cleanupRenderedPages,
            invalidateScaleCache: vi.fn(),
            resetScale: vi.fn(),
            resetInsets: vi.fn(),
            setupPagePlaceholders,
            computeFitWidthScale,
            computeSkeletonInsets,
            invalidateRenderedPages: vi.fn(),
            consumePendingInvalidation: () => null,
            commentSync: {
                incrementSyncToken: vi.fn(),
                scheduleAnnotationCommentsSync: vi.fn(),
            },
            editor: {
                destroyAnnotationEditor,
                initAnnotationEditor: vi.fn(),
            },
            pinCurrentPageDuringRecovery: vi.fn(),
            suppressNextZoomRerender: vi.fn(),
            beginVisualReloadTransition: vi.fn(() => 17),
            endVisualReloadTransition,
            emit: vi.fn(),
        });

        preserveNextSourceReloadVisibleContent();
        viewerContainer.scrollLeft = 62;
        viewerContainer.scrollTop = 1400;
        scheduleLoadFromSource(true);
        await flushLifecycleTasks();

        expect(loadPdf).toHaveBeenCalledWith(expect.any(Blob), { preservePageStructure: true });
        expect(viewerContainer.scrollLeft).toBe(45);
        expect(viewerContainer.scrollTop).toBe(1234);
        expect(cleanupRenderedPages).not.toHaveBeenCalled();
        expect(destroyAnnotationEditor).not.toHaveBeenCalled();
        expect(renderVisiblePages).not.toHaveBeenCalled();
        expect(scrollToPage).not.toHaveBeenCalled();
        expect(updateVisibleRange).not.toHaveBeenCalled();
        expect(ensurePageMetricsInRange).not.toHaveBeenCalled();
        expect(getPage).not.toHaveBeenCalled();
        expect(computeFitWidthScale).not.toHaveBeenCalled();
        expect(computeSkeletonInsets).not.toHaveBeenCalled();
        expect(setupPagePlaceholders).not.toHaveBeenCalled();
        expect(endVisualReloadTransition).toHaveBeenCalledWith(17, 'preserved-load-complete');
    });

    it('settles document loading before deferred warm render and annotation sync', async () => {
        const callOrder: string[] = [];
        const currentPage = ref(1);
        const visibleRange = ref({
            start: 1,
            end: 1,
        });
        const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
        const numPages = ref(12);
        const renderVisiblePages = vi.fn(async (range: {
            start: number;
            end: number;
        }) => {
            callOrder.push(`render:${range.start}-${range.end}`);
        });
        const applySearchHighlights = vi.fn(() => {
            callOrder.push('search');
        });
        const scheduleAnnotationCommentsSync = vi.fn(() => {
            callOrder.push('annotation-sync');
        });
        const onDocumentLoadStateChange = vi.fn((payload: { phase: 'started' | 'settled' }) => {
            callOrder.push(`load:${payload.phase}`);
        });

        const { scheduleLoadFromSource } = usePdfViewerDocumentLifecycle({
            viewerContainer: ref(cast<HTMLElement>({ querySelector: vi.fn(() => ({})) })),
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
            ensurePageMetricsInRange: vi.fn(async () => false),
            getPage: vi.fn(async () => ({}) as PDFPageProxy),
            renderVisiblePages,
            getVisibleRange: () => ({
                start: 1,
                end: 3,
            }),
            reRenderVisiblePagesAndSyncCurrentPage: vi.fn(async () => {}),
            syncCurrentPageFromViewport: vi.fn(async () => {
                callOrder.push('sync');
            }),
            applySearchHighlights,
            updateVisibleRange: vi.fn(),
            scrollToPage: vi.fn(),
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
                scheduleAnnotationCommentsSync,
            },
            editor: {
                destroyAnnotationEditor: vi.fn(),
                initAnnotationEditor: vi.fn(),
            },
            pinCurrentPageDuringRecovery: vi.fn(),
            suppressNextZoomRerender: vi.fn(),
            beginVisualReloadTransition: vi.fn(() => 17),
            endVisualReloadTransition: vi.fn(),
            onDocumentLoadStateChange,
            emit: vi.fn(),
        });

        scheduleLoadFromSource();
        await flushLifecycleTasks();

        expect(onDocumentLoadStateChange).toHaveBeenLastCalledWith({
            token: 1,
            phase: 'settled',
        });
        expect(renderVisiblePages).toHaveBeenCalledWith({
            start: 1,
            end: 1,
        }, { bufferOverride: 0 });
        expect(renderVisiblePages).toHaveBeenLastCalledWith({
            start: 1,
            end: 3,
        });
        expect(applySearchHighlights).toHaveBeenCalledOnce();
        expect(scheduleAnnotationCommentsSync).toHaveBeenCalledWith(true);

        const settleIndex = callOrder.indexOf('load:settled');
        expect(settleIndex).toBeGreaterThan(callOrder.indexOf('sync'));
        expect(callOrder.indexOf('render:1-3')).toBeGreaterThan(settleIndex);
        expect(callOrder.indexOf('search')).toBeGreaterThan(settleIndex);
        expect(callOrder.indexOf('annotation-sync')).toBeGreaterThan(settleIndex);
    });
});
