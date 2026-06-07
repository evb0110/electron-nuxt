import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import { usePdfRenderViewModel } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRenderViewModel';
import { PDF_VIEWER_PAGE_SKELETON_DELAY_MS } from '@app/constants/timeouts';
import type {
    PDFDocumentProxy,
    TPdfSource,
} from '@app/types/pdf';
import { cast } from '@tests/helpers/cast';

function createHarness(options?: {
    hasMountedPageCanvas?: (page: number) => boolean;
    isPageRendering?: (page: number) => boolean;
    shouldShowSkeleton?: (page: number) => boolean;
}) {
    const scope = effectScope();
    const mountedPages = ref([1]);
    const visibleRange = ref({
        start: 1,
        end: 1,
    });
    const suppressPagedBufferRender = ref(false);
    const renderVisiblePages = vi.fn(async () => {});
    const runGuardedTask = vi.fn((task: () => Promise<void>) => {
        void task();
    });

    const viewModel = scope.run(() => usePdfRenderViewModel({
        src: computed(() => null as TPdfSource | null),
        isLoading: ref(false),
        pdfDocument: shallowRef<PDFDocumentProxy | null>(cast({})),
        viewerContainer: ref(null),
        isVisualReloadTransitionActive: ref(false),
        suppressLoadingOverlay: computed(() => false),
        suppressPagedBufferRender,
        skeletonContentInsets: ref(null),
        pagesToRender: computed(() => mountedPages.value),
        isPageBuffered: vi.fn(() => false),
        isPageRenderedForClass: vi.fn(() => false),
        isPageRendering: options?.isPageRendering ?? vi.fn(() => false),
        hasMountedPageCanvas: options?.hasMountedPageCanvas ?? vi.fn(() => false),
        shouldShowSkeleton: options?.shouldShowSkeleton ?? vi.fn(() => false),
        visibleRange,
        currentPage: ref(1),
        zoom: computed(() => 1),
        zoomMode: computed(() => 'fit-height' as const),
        fitMode: computed(() => 'height' as const),
        effectiveScale: ref(1),
        continuousScroll: computed(() => false),
        numPages: ref(1_000),
        markersByPage: ref(new Map<number, never[]>()),
        linksByPage: computed<Record<number, never[]>>(() => ({})),
        renderVisiblePages,
        runGuardedTask,
    }));

    return {
        mountedPages,
        renderVisiblePages,
        runGuardedTask,
        scope,
        suppressPagedBufferRender,
        visibleRange,
        viewModel,
    };
}

describe('usePdfRenderViewModel', () => {
    it('does not schedule the paged buffer while current-page fit rerendering owns the row', async () => {
        const {
            mountedPages,
            renderVisiblePages,
            runGuardedTask,
            scope,
            suppressPagedBufferRender,
            visibleRange,
        } = createHarness();
        suppressPagedBufferRender.value = true;

        mountedPages.value = [928];
        visibleRange.value = {
            start: 928,
            end: 928,
        };
        await nextTick();
        await nextTick();

        expect(runGuardedTask).not.toHaveBeenCalled();
        expect(renderVisiblePages).not.toHaveBeenCalled();

        scope.stop();
    });

    it('skips a queued paged buffer render when current-page fit rerendering starts first', async () => {
        const {
            mountedPages,
            renderVisiblePages,
            runGuardedTask,
            scope,
            suppressPagedBufferRender,
            visibleRange,
        } = createHarness();

        mountedPages.value = [928];
        visibleRange.value = {
            start: 928,
            end: 928,
        };
        await nextTick();
        suppressPagedBufferRender.value = true;
        await nextTick();
        await Promise.resolve();

        expect(runGuardedTask).not.toHaveBeenCalled();
        expect(renderVisiblePages).not.toHaveBeenCalled();

        scope.stop();
    });

    it('hides page skeletons while an active render has mounted a canvas', () => {
        vi.useFakeTimers();
        try {
            const hasMountedCanvas = ref(false);
            const isRendering = ref(false);
            const {
                scope,
                viewModel,
            } = createHarness({
                hasMountedPageCanvas: () => hasMountedCanvas.value,
                isPageRendering: () => isRendering.value,
                shouldShowSkeleton: () => true,
            });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            vi.advanceTimersByTime(PDF_VIEWER_PAGE_SKELETON_DELAY_MS);
            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            hasMountedCanvas.value = true;
            isRendering.value = true;
            expect(viewModel.shouldShowPageSkeleton(1)).toBe(false);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps recovery skeletons eligible for an orphan mounted canvas', () => {
        vi.useFakeTimers();
        try {
            const hasMountedCanvas = ref(true);
            const {
                scope,
                viewModel,
            } = createHarness({
                hasMountedPageCanvas: () => hasMountedCanvas.value,
                isPageRendering: () => false,
                shouldShowSkeleton: () => true,
            });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            vi.advanceTimersByTime(PDF_VIEWER_PAGE_SKELETON_DELAY_MS);
            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});
