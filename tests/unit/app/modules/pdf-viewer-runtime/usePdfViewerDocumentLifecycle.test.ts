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
            emit,
        });

        scheduleLoadFromSource(true);
        await flushLifecycleTasks();

        expect(syncCurrentPageFromViewport).not.toHaveBeenCalled();
        expect(pinCurrentPageDuringRecovery).toHaveBeenCalledWith(200, {
            durationMs: 900,
            reason: 'reload-recovery',
        });
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
});
