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
import {
    shouldPreserveThumbnailBitmap,
    usePdfThumbnailRenderRuntime,
} from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailRenderRuntime';
import {
    resetCoordinatedPdfPageRendersForTest,
    runCoordinatedPdfPageRender,
} from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import { cast } from '@tests/helpers/cast';

const pdfDocumentLeaseMocks = vi.hoisted(() => ({leasePdfDocumentPage: vi.fn()}));

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

    it('retains an existing bitmap while its replacement is rendering', () => {
        expect(shouldPreserveThumbnailBitmap({
            width: 240,
            height: 320,
        })).toBe(true);
        expect(shouldPreserveThumbnailBitmap({
            width: 0,
            height: 320,
        })).toBe(false);
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
        const releases: Array<ReturnType<typeof vi.fn>> = [];
        pdfDocumentLeaseMocks.leasePdfDocumentPage.mockImplementation(async () => {
            const release = vi.fn();
            releases.push(release);
            return {
                page: pdfPage,
                release,
            };
        });
        const thumbnailAspectRatios = ref<Array<number | null>>([]);
        const thumbnailRenderWidth = ref(100);
        const updateThumbnailAspectRatio = vi.fn();
        const runtime = usePdfThumbnailRenderRuntime({
            dom: {
                getCanvas: () => canvas,
                isCanvasViewportVisible: () => true,
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
                clearThumbnailAspectRatios: vi.fn(),
                resolveViewportAnchorPage: () => null,
                shouldPreferVisibleAnchorOverCurrentPage: () => false,
                thumbnailAspectRatios,
                thumbnailRenderWidth,
                updateThumbnailAspectRatio,
                viewportPages: computed(() => [1]),
                virtualPages: computed(() => [1]),
            },
            source: {
                currentPage: computed(() => 1),
                invalidationRequest: computed(() => null),
                isActive: computed(() => true),
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
        expect(releases).toHaveLength(2);
        releases.forEach(release => expect(release).toHaveBeenCalledOnce());
        expect(pdfPage.cleanup).not.toHaveBeenCalled();
        expect(canvas.dataset.thumbnailRendered).toBe('true');
        expect(updateThumbnailAspectRatio).toHaveBeenCalledWith(1, 2);
    });

    it('retries a demanded thumbnail dropped by a raster-width transition', async () => {
        vi.useFakeTimers();
        pdfDocumentLeaseMocks.leasePdfDocumentPage.mockReset();
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
        const firstLease = Promise.withResolvers<{
            page: PDFPageProxy;
            release: ReturnType<typeof vi.fn>;
        }>();
        pdfDocumentLeaseMocks.leasePdfDocumentPage
            .mockReturnValueOnce(firstLease.promise)
            .mockResolvedValue({
                page: pdfPage,
                release: vi.fn(),
            });
        const thumbnailRenderWidth = ref(100);
        const runtime = usePdfThumbnailRenderRuntime({
            dom: {
                getCanvas: () => canvas,
                isCanvasViewportVisible: () => true,
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
                clearThumbnailAspectRatios: vi.fn(),
                resolveViewportAnchorPage: () => null,
                shouldPreferVisibleAnchorOverCurrentPage: () => false,
                thumbnailAspectRatios: ref<Array<number | null>>([2]),
                thumbnailRenderWidth,
                updateThumbnailAspectRatio: vi.fn(),
                viewportPages: computed(() => [1]),
                virtualPages: computed(() => [1]),
            },
            source: {
                currentPage: computed(() => 1),
                invalidationRequest: computed(() => null),
                isActive: computed(() => true),
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
        await vi.waitFor(() => expect(pdfDocumentLeaseMocks.leasePdfDocumentPage).toHaveBeenCalledOnce());

        thumbnailRenderWidth.value = 120;
        firstLease.resolve({
            page: pdfPage,
            release: vi.fn(),
        });
        await vi.waitFor(() => expect(runtime.getRenderSummary().renderingCount).toBe(0));
        await vi.advanceTimersByTimeAsync(25);

        await vi.waitFor(() => {
            expect(pdfDocumentLeaseMocks.leasePdfDocumentPage).toHaveBeenCalledTimes(2);
            expect(pdfPage.render).toHaveBeenCalledOnce();
            expect(canvas.dataset.thumbnailRendered).toBe('true');
        });
    });

    it('aborts a thumbnail waiting for coordinated rendering and releases its exact lease', async () => {
        vi.useFakeTimers();
        const canvas = cast<HTMLCanvasElement>({
            dataset: {},
            getContext: vi.fn(() => ({ drawImage: vi.fn() })),
            height: 0,
            style: { removeProperty: vi.fn() },
            width: 0,
        });
        const pdfDocument = cast<PDFDocumentProxy>({ numPages: 1 });
        const pdfPage = cast<PDFPageProxy>({
            getViewport: vi.fn(({scale}: {scale: number}) => ({
                width: 100 * scale,
                height: 200 * scale,
            })),
            pageNumber: 1,
            render: vi.fn(),
        });
        const blockingRender = Promise.withResolvers<undefined>();
        const blockingRun = runCoordinatedPdfPageRender({
            owner: 'visible-page',
            pageNumber: 1,
            pdfPage,
            priority: 200,
            startRender: () => ({
                cancel: vi.fn(),
                promise: blockingRender.promise,
            }),
        });
        await Promise.resolve();

        const releases: Array<ReturnType<typeof vi.fn>> = [];
        const updateThumbnailAspectRatio = vi.fn();
        pdfDocumentLeaseMocks.leasePdfDocumentPage.mockImplementation(async () => {
            const release = vi.fn();
            releases.push(release);
            return {
                page: pdfPage,
                release,
            };
        });
        const runtime = usePdfThumbnailRenderRuntime({
            dom: {
                getCanvas: () => canvas,
                isCanvasViewportVisible: () => true,
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
                clearThumbnailAspectRatios: vi.fn(),
                resolveViewportAnchorPage: () => null,
                shouldPreferVisibleAnchorOverCurrentPage: () => false,
                thumbnailAspectRatios: ref<Array<number | null>>([]),
                thumbnailRenderWidth: ref(100),
                updateThumbnailAspectRatio,
                viewportPages: computed(() => [1]),
                virtualPages: computed(() => [1]),
            },
            source: {
                currentPage: computed(() => 1),
                invalidationRequest: computed(() => null),
                isActive: computed(() => true),
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
        await vi.waitFor(() => expect(releases).toHaveLength(2));
        const queuedRenderRelease = releases[1];
        if (!queuedRenderRelease) {
            throw new Error('Expected a thumbnail render lease');
        }
        expect(queuedRenderRelease).not.toHaveBeenCalled();
        expect(pdfPage.render).not.toHaveBeenCalled();
        expect(updateThumbnailAspectRatio).toHaveBeenCalledWith(1, 2);

        runtime.cancelAllRenders();
        await vi.waitFor(() => expect(queuedRenderRelease).toHaveBeenCalledOnce());
        expect(pdfPage.render).not.toHaveBeenCalled();

        blockingRender.resolve(undefined);
        await blockingRun;
    });
});
