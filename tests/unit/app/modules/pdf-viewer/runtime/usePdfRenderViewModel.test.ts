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
import type {
    PDFDocumentProxy,
    TPdfSource,
} from '@app/types/pdf';
import { cast } from '@tests/helpers/cast';

function createHarness() {
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

    scope.run(() => usePdfRenderViewModel({
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
        shouldShowSkeleton: vi.fn(() => false),
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
});
