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
import { usePdfViewerFitWidthController } from '@app/modules/pdf-viewer/runtime/viewport/usePdfViewerFitWidthController';
import type { PDFDocumentProxy } from '@app/types/pdf';
import { cast } from '@tests/helpers/cast';

describe('usePdfViewerFitWidthController', () => {
    it('syncs fit-width zoom mode when the current page changes', async () => {
        const currentPage = ref(1);
        const emitZoomMode = vi.fn();
        const syncHorizontalScrollForZoomMode = vi.fn();
        const isFitWidthScaleCurrent = vi.fn(() => true);
        const viewerContainer = ref(cast<HTMLElement>({}));
        const scope = effectScope();

        try {
            scope.run(() => {
                usePdfViewerFitWidthController({
                    viewerContainer,
                    pdfDocument: shallowRef<PDFDocumentProxy | null>(cast({})),
                    isLoading: ref(false),
                    continuousScroll: computed(() => true),
                    fitMode: computed(() => 'width' as const),
                    zoomMode: computed(() => 'custom' as const),
                    zoom: computed(() => 1),
                    effectiveScale: computed(() => 1),
                    viewMode: computed(() => 'single' as const),
                    currentPage,
                    numPages: ref(10),
                    pageMetricsVersion: ref(0),
                    visibleRange: ref({
                        start: 1,
                        end: 1,
                    }),
                    captureViewerScrollSnapshot: vi.fn(() => null),
                    computeFitWidthScale: vi.fn(() => false),
                    isFitWidthScaleCurrent,
                    syncHorizontalScrollForZoomMode,
                    cancelInFlightRenders: vi.fn(),
                    reRenderAllVisiblePages: vi.fn(async () => {}),
                    emitZoomMode,
                });
            });

            currentPage.value = 2;
            await nextTick();

            expect(isFitWidthScaleCurrent).toHaveBeenCalledWith(viewerContainer.value);
            expect(emitZoomMode).toHaveBeenCalledWith('fit-width');
            expect(syncHorizontalScrollForZoomMode).toHaveBeenCalledOnce();
        } finally {
            scope.stop();
        }
    });
});
