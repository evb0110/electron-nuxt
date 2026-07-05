import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
} from 'vue';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
import { usePdfThumbnailRenderRuntime } from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailRenderRuntime';
import { resetCoordinatedPdfPageRendersForTest } from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import { cast } from '@tests/helpers/cast';

const pdfDocumentLeaseMocks = vi.hoisted(() => ({
    leasePdfDocumentPage: vi.fn(),
    releasePdfDocumentPage: vi.fn(),
}));

vi.mock('vue', async (importOriginal) => ({
    ...(await importOriginal()),
    onBeforeUnmount: vi.fn(),
    onMounted: vi.fn(),
}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/usePdfDocument', () => pdfDocumentLeaseMocks);

describe('usePdfThumbnailRenderRuntime', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        resetCoordinatedPdfPageRendersForTest();
    });

    it('leases thumbnail pages and leaves cleanup with the shared page cache owner', async () => {
        vi.useFakeTimers();
        const context = { drawImage: vi.fn() };
        const canvas = cast<HTMLCanvasElement>({
            dataset: {},
            getContext: vi.fn(() => context),
            height: 0,
            style: { removeProperty: vi.fn() },
            width: 0,
        });
        const pdfDocument = cast<PDFDocumentProxy>({ numPages: 1 });
        const pdfPage = cast<PDFPageProxy>({
            cleanup: vi.fn(),
            getViewport: vi.fn(({scale}: {scale: number}) => ({
                width: 100 * scale,
                height: 200 * scale,
            })),
            pageNumber: 1,
            render: vi.fn(() => ({
                cancel: vi.fn(),
                promise: Promise.resolve(),
            })),
        });
        pdfDocumentLeaseMocks.leasePdfDocumentPage.mockResolvedValue(pdfPage);
        const thumbnailAspectRatios = ref<Array<number | null>>([]);
        const thumbnailRenderWidth = ref(100);
        const runtime = usePdfThumbnailRenderRuntime({
            dom: {
                getCanvas: () => canvas,
                resolveVisibleContainer: () => cast<HTMLElement>({ querySelectorAll: () => [] }),
            },
            effects: {
                cancelActivePaneRefresh: vi.fn(),
                measureThumbnailHeight: vi.fn(),
                onSourceCycleStarted: vi.fn(),
                refreshVisibleThumbnailPane: vi.fn(),
                resetMeasurementState: vi.fn(),
                scheduleActivePaneRefresh: vi.fn(),
            },
            layout: {
                resolveViewportAnchorPage: () => null,
                shouldPreferVisibleAnchorOverCurrentPage: () => false,
                thumbnailAspectRatios,
                thumbnailRenderWidth,
                virtualPages: computed(() => [1]),
            },
            source: {
                currentPage: computed(() => 1),
                invalidationRequest: computed(() => null),
                isActive: computed(() => true),
                pagePreviewProvider: computed(() => null),
                pdfDocument: computed(() => pdfDocument),
                totalPages: computed(() => 1),
            },
            visuals: {
                annotationSettings: computed(() => null),
                editedTextMarkupComments: computed(() => []),
                editedTextMarkupVisualSignature: computed(() => ''),
                hiddenAnnotationIdSet: computed(() => new Set<string>()),
                hiddenAnnotationIdsSignature: computed(() => ''),
            },
        });

        void runtime.scheduleVisibleThumbnailRender();
        await vi.advanceTimersByTimeAsync(25);
        await vi.waitFor(() => {
            expect(pdfPage.render).toHaveBeenCalledOnce();
        });

        expect(pdfDocumentLeaseMocks.leasePdfDocumentPage).toHaveBeenCalledWith(pdfDocument, 1);
        expect(pdfDocumentLeaseMocks.releasePdfDocumentPage).toHaveBeenCalledWith(pdfDocument, 1, pdfPage);
        expect(pdfPage.cleanup).not.toHaveBeenCalled();
        expect(canvas.dataset.thumbnailRendered).toBe('true');
    });
});
