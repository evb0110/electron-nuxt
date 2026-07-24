// @vitest-environment happy-dom

import {
    computed,
    createApp,
    defineComponent,
    nextTick,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfScroll } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import { usePdfViewerVirtualization } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization';
import { resolvePdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';
import { usePdfViewerViewportLifecycle } from '@app/modules/pdf-viewer/runtime/viewport/usePdfViewerViewportLifecycle';
import { cast } from '@tests/helpers/cast';
import { createTestPdfViewportWritePort } from '@tests/helpers/createTestPdfViewportWritePort';

const performancePolicy = resolvePdfRenderPerformancePolicy({
    lowCpu: false,
    lowMemory: false,
});

describe('usePdfViewerViewportLifecycle', () => {
    it('recomputes the mounted window from the active scroll offset when geometry updates', async () => {
        const numPages = ref(100);
        const basePageHeight = ref<number | null>(900);
        const pageMetricsVersion = ref(0);
        const container = cast<HTMLElement>({
            clientHeight: 800,
            clientWidth: 800,
            querySelectorAll: () => [],
            scrollLeft: 0,
            scrollTop: 10_000,
        });
        const scroll = usePdfScroll({viewportWritePort: createTestPdfViewportWritePort().port});
        const visibleRange = scroll.visibleRange;
        const virtualization = usePdfViewerVirtualization({
            performancePolicy,
            bufferPages: computed(() => 0),
            viewMode: computed(() => 'single'),
            numPages,
            currentPage: ref(1),
            continuousScroll: computed(() => true),
            basePageWidth: ref(600),
            basePageHeight,
            pageMetrics: ref([]),
            pageMetricsVersion,
            effectiveScale: ref(1),
            scaledMargin: ref(20),
            visibleRange,
            navigationAnchorPage: ref(null),
            resizeTransitionAnchorPage: ref(null),
            zoomVirtualizationFreeze: ref(null),
        });
        expect(virtualization.pageLayout.value).not.toBeNull();
        scroll.setPageLayoutMetrics(virtualization.pageLayout.value);
        expect(scroll.getVisiblePageRange(container, numPages.value).start).toBeGreaterThan(1);
        visibleRange.value = {
            start: 1,
            end: 1,
        };
        const root = document.createElement('div');
        const app = createApp(defineComponent({
            name: 'PdfViewerViewportLifecycleTest',
            setup() {
                usePdfViewerViewportLifecycle({
                    src: computed(() => null),
                    isLoading: ref(false),
                    viewerHost: ref(null),
                    viewerContainer: ref(container),
                    resizeTransitionVisible: ref(false),
                    resizeTransitionAnchorPage: ref(null),
                    currentPage: ref(1),
                    visibleRange,
                    continuousScroll: computed(() => true),
                    fitMode: computed(() => 'width'),
                    zoomMode: computed(() => 'fit-width'),
                    zoom: computed(() => 1),
                    effectiveScale: computed(() => 1),
                    viewMode: computed(() => 'single'),
                    numPages,
                    pageMetricsVersion,
                    pageLayout: virtualization.pageLayout,
                    clearPinnedViewportPage: vi.fn(),
                    clearPendingImagePlacement: vi.fn(),
                    setPageLayoutMetrics: scroll.setPageLayoutMetrics,
                    syncHorizontalScrollForZoomMode: vi.fn(),
                    handleViewerScroll: vi.fn(),
                    summarizeViewerStateForLog: vi.fn(),
                    loadingLabel: () => 'Loading',
                });
                return () => null;
            },
        }));

        try {
            app.mount(root);
            await nextTick();

            const provisionalStart = visibleRange.value.start;
            expect(provisionalStart).toBeGreaterThan(1);
            expect(virtualization.pagesToRender.value).toContain(provisionalStart);

            basePageHeight.value = 100;
            pageMetricsVersion.value += 1;
            await nextTick();

            expect(visibleRange.value.start).toBeGreaterThan(provisionalStart);
            expect(virtualization.pagesToRender.value).toContain(visibleRange.value.start);
            expect(virtualization.pagesToRender.value).not.toContain(provisionalStart);
        } finally {
            app.unmount();
        }
    });
});
