import {
    computed,
    nextTick,
    ref,
    type Ref,
} from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IDjvuPageSize } from '@app/platform/browser-api/public';
import type { TDjvuScrollDirection } from '@app/modules/djvu-viewer/createDjvuPageRenderList';
import {
    useDjvuPreviewRuntime,
    type IDjvuPageState,
} from '@app/modules/djvu-viewer/runtime/useDjvuPreviewRuntime';

const previewMocks = vi.hoisted(() => ({
    createDjvuPagePreviewSourceFromPath: vi.fn(),
    getPageSizes: vi.fn(),
    renderPageObjectUrl: vi.fn(),
    revokeObjectURL: vi.fn(),
    terminate: vi.fn(),
}));

type TInitialVisualEvent =
    | {type: 'pending';}
    | {
        pageNumber: number;
        type: 'ready';
    };

vi.mock('@app/platform/browser-api/public', () => ({ createDjvuPagePreviewSourceFromPath: previewMocks.createDjvuPagePreviewSourceFromPath }));

class InstantImage {
    public onerror: (() => void) | null = null;
    public onload: (() => void) | null = null;

    public set src(_value: string) {
        queueMicrotask(() => this.onload?.());
    }
}

function createDeferred<T>() {
    let resolveValue!: (value: T | PromiseLike<T>) => void;
    let rejectValue!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
        resolveValue = resolve;
        rejectValue = reject;
    });

    return {
        promise,
        reject: rejectValue,
        resolve: resolveValue,
    };
}

function settleWithTimeout(promise: Promise<void>) {
    return Promise.race([
        promise.then(() => 'settled' as const),
        new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 25)),
    ]);
}

function createPreviewRuntimeHarness(options: {
    initialVisualPageNumbers?: number[];
    initialVisualPageNumbersRef?: Ref<number[]>;
    isActive?: boolean;
    neededDeviceWidth?: number | ((pageNumber: number) => number);
    scrollDirection?: Ref<TDjvuScrollDirection>;
    scrollWindowRef?: Ref<{
        start: number;
        end: number;
        mostVisiblePage: number | null;
        pageNumbers: number[];
    }>;
    scrollWindow?: {
        start: number;
        end: number;
        mostVisiblePage: number | null;
        pageNumbers: number[];
    };
} = {}) {
    const src = ref('fixture.djvu');
    const isActiveSource = ref(options.isActive ?? true);
    const neededDeviceWidthOption = options.neededDeviceWidth;
    const getNeededDeviceWidth: (pageNumber: number) => number = typeof neededDeviceWidthOption === 'function'
        ? neededDeviceWidthOption
        : () => neededDeviceWidthOption ?? 100;
    const pageSizes = ref<IDjvuPageSize[]>([]);
    const pageStates = ref<IDjvuPageState[]>([]);
    const currentPage = ref(1);
    const isLoading = ref(Boolean(src.value));
    const viewerError = ref<string | null>(null);
    const emittedTotalPages: number[] = [];
    const emittedInitialVisualEvents: TInitialVisualEvent[] = [];
    const runtime = useDjvuPreviewRuntime({
        state: {
            currentPage,
            isLoading,
            pageSizes,
            pageStates,
            viewerError,
        },
        source: {
            getInitialVisualPageNumbers: () => (
                options.initialVisualPageNumbersRef?.value
                ?? options.initialVisualPageNumbers
                ?? options.scrollWindowRef?.value.pageNumbers
                ?? options.scrollWindow?.pageNumbers
                ?? [currentPage.value]
            ),
            getNeededDeviceWidth,
            getOpenErrorMessage: () => 'open failed',
            getSrc: () => src.value,
            isActive: computed(() => isActiveSource.value),
            isContinuousScroll: computed(() => true),
            resolveContinuousScrollWindow: () => options.scrollWindowRef?.value ?? options.scrollWindow ?? ({
                start: 1,
                end: 1,
                mostVisiblePage: 1,
                pageNumbers: [1],
            }),
            scrollDirection: options.scrollDirection ?? ref(0),
            totalPages: computed(() => pageSizes.value.length),
        },
        effects: {
            clearPageElements: vi.fn(),
            emitCurrentPage: vi.fn(),
            emitDocument: vi.fn(),
            emitInitialVisualPending: () => emittedInitialVisualEvents.push({ type: 'pending' }),
            emitInitialVisualReady: payload => emittedInitialVisualEvents.push({
                type: 'ready',
                pageNumber: payload.pageNumber,
            }),
            emitLoading: vi.fn(),
            emitTotalPages: value => emittedTotalPages.push(value),
            invalidateContinuousScrollWindowCache: vi.fn(),
            measureContainer: vi.fn(),
            resetScrollState: vi.fn(),
            resetViewerScrollPosition: vi.fn(),
            scheduleViewportSync: vi.fn(),
            syncHorizontalScrollForZoomMode: vi.fn(),
        },
        environment: {
            getWindow: () => ({
                clearTimeout: globalThis.clearTimeout,
                setTimeout: globalThis.setTimeout,
            }),
            isClient: () => true,
        },
    });

    return {
        emittedInitialVisualEvents,
        emittedTotalPages,
        isLoading,
        isActiveSource,
        pageStates,
        runtime,
        viewerError,
    };
}

describe('useDjvuPreviewRuntime', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('Image', InstantImage);
        previewMocks.getPageSizes.mockResolvedValue([{
            width: 100,
            height: 200,
        }]);
        previewMocks.renderPageObjectUrl.mockImplementation(async (pageNumber: number) => ({
            objectUrl: `blob:page-${pageNumber}`,
            renderedPx: 100,
        }));
        previewMocks.createDjvuPagePreviewSourceFromPath.mockResolvedValue({
            getPageSizes: previewMocks.getPageSizes,
            renderPageObjectUrl: previewMocks.renderPageObjectUrl,
            revokeObjectURL: previewMocks.revokeObjectURL,
            terminate: previewMocks.terminate,
        });
    });

    it('emits initial visual pending then ready when the first visible object URL is committed', async () => {
        const {
            emittedInitialVisualEvents,
            pageStates,
            runtime,
        } = createPreviewRuntimeHarness();

        await vi.waitFor(() => expect(pageStates.value[0]?.status).toBe('loaded'));

        expect(emittedInitialVisualEvents).toEqual([
            { type: 'pending' },
            {
                type: 'ready',
                pageNumber: 1,
            },
        ]);

        runtime.syncLoadedPages();
        await nextTick();

        expect(emittedInitialVisualEvents).toEqual([
            { type: 'pending' },
            {
                type: 'ready',
                pageNumber: 1,
            },
        ]);

        runtime.dispose();
    });

    it('waits for the visible page before marking initial visual ready when prefetch renders first', async () => {
        previewMocks.getPageSizes.mockResolvedValue(Array.from({ length: 3 }, () => ({
            width: 100,
            height: 200,
        })));
        const firstPageRender = createDeferred<{
            objectUrl: string;
            renderedPx: number;
        }>();
        previewMocks.renderPageObjectUrl.mockImplementation((pageNumber: number) => {
            if (pageNumber === 1) {
                return firstPageRender.promise;
            }

            return Promise.resolve({
                objectUrl: `blob:page-${pageNumber}`,
                renderedPx: 100,
            });
        });
        const scrollWindow = {
            start: 1,
            end: 1,
            mostVisiblePage: 1,
            pageNumbers: [1],
        };
        const {
            emittedInitialVisualEvents,
            pageStates,
            runtime,
        } = createPreviewRuntimeHarness({ scrollWindow });

        await vi.waitFor(() => expect(pageStates.value[1]?.objectUrl).toBe('blob:page-2'));

        expect(emittedInitialVisualEvents).toEqual([{ type: 'pending' }]);

        firstPageRender.resolve({
            objectUrl: 'blob:page-1',
            renderedPx: 100,
        });

        await vi.waitFor(() => expect(emittedInitialVisualEvents).toContainEqual({
            type: 'ready',
            pageNumber: 1,
        }));

        runtime.dispose();
    });

    it('emits initial visual ready when initial visible pages reach terminal render errors', async () => {
        previewMocks.renderPageObjectUrl.mockRejectedValue(new Error('render failed'));
        const {
            emittedInitialVisualEvents,
            pageStates,
            runtime,
        } = createPreviewRuntimeHarness();

        await vi.waitFor(() => expect(pageStates.value[0]?.status).toBe('error'));

        expect(emittedInitialVisualEvents).toEqual([
            { type: 'pending' },
            {
                type: 'ready',
                pageNumber: 1,
            },
        ]);

        runtime.dispose();
    });

    it('emits initial visual ready when opening the preview source fails', async () => {
        previewMocks.createDjvuPagePreviewSourceFromPath.mockRejectedValueOnce(new Error('open failed'));
        const {
            emittedInitialVisualEvents,
            isLoading,
            runtime,
            viewerError,
        } = createPreviewRuntimeHarness();

        await vi.waitFor(() => expect(viewerError.value).toBe('open failed'));

        expect(isLoading.value).toBe(false);
        expect(emittedInitialVisualEvents).toEqual([
            { type: 'pending' },
            {
                type: 'ready',
                pageNumber: 1,
            },
        ]);

        runtime.dispose();
    });

    it('revokes loaded object URLs and terminates the preview worker when suspended', async () => {
        const {
            isActiveSource,
            pageStates,
            runtime,
        } = createPreviewRuntimeHarness();

        await vi.waitFor(() => expect(pageStates.value[0]?.status).toBe('loaded'));

        expect(pageStates.value[0]?.objectUrl).toBe('blob:page-1');

        isActiveSource.value = false;
        await nextTick();

        expect(previewMocks.revokeObjectURL).toHaveBeenCalledWith('blob:page-1');
        expect(previewMocks.terminate).toHaveBeenCalledTimes(1);
        expect(pageStates.value[0]).toMatchObject({
            objectUrl: null,
            status: 'idle',
        });

        runtime.dispose();
    });

    it('does not re-arm viewer load settling while inactive during an initial render', async () => {
        const firstPageRender = createDeferred<{
            objectUrl: string;
            renderedPx: number;
        }>();
        previewMocks.renderPageObjectUrl.mockReturnValue(firstPageRender.promise);
        const {
            isActiveSource,
            pageStates,
            runtime,
        } = createPreviewRuntimeHarness();

        await vi.waitFor(() => expect(pageStates.value[0]?.status).toBe('loading'));

        isActiveSource.value = false;
        await nextTick();

        await expect(settleWithTimeout(runtime.waitForViewerLoadSettled())).resolves.toBe('settled');

        runtime.dispose();
    });

    it('emits total pages when a DjVu source first loads after inactive startup', async () => {
        const {
            emittedTotalPages,
            isActiveSource,
            pageStates,
            runtime,
        } = createPreviewRuntimeHarness({ isActive: false });

        await nextTick();

        expect(previewMocks.createDjvuPagePreviewSourceFromPath).not.toHaveBeenCalled();
        expect(emittedTotalPages).toEqual([0]);

        isActiveSource.value = true;

        await vi.waitFor(() => expect(pageStates.value[0]?.status).toBe('loaded'));

        expect(emittedTotalPages).toEqual([
            0,
            1,
        ]);

        runtime.dispose();
    });

    it('keeps retained continuous-scroll window pages in the preview render queue', async () => {
        previewMocks.getPageSizes.mockResolvedValue(Array.from({ length: 6 }, () => ({
            width: 100,
            height: 200,
        })));

        const {
            pageStates,
            runtime,
        } = createPreviewRuntimeHarness({scrollWindow: {
            start: 2,
            end: 4,
            mostVisiblePage: 3,
            pageNumbers: [
                2,
                3,
                4,
            ],
        }});

        await vi.waitFor(() => {
            expect(pageStates.value[1]?.status).toBe('loaded');
            expect(pageStates.value[2]?.status).toBe('loaded');
            expect(pageStates.value[3]?.status).toBe('loaded');
        });

        expect(previewMocks.renderPageObjectUrl).toHaveBeenCalledWith(2, expect.any(Object));
        expect(previewMocks.renderPageObjectUrl).toHaveBeenCalledWith(3, expect.any(Object));
        expect(previewMocks.renderPageObjectUrl).toHaveBeenCalledWith(4, expect.any(Object));

        runtime.dispose();
    });

    it('retains recently rendered continuous-scroll pages while prioritizing ahead pages', async () => {
        previewMocks.getPageSizes.mockResolvedValue(Array.from({ length: 16 }, () => ({
            width: 100,
            height: 200,
        })));
        const scrollDirection = ref<TDjvuScrollDirection>(1);
        const scrollWindowRef = ref({
            start: 1,
            end: 1,
            mostVisiblePage: 1,
            pageNumbers: [1],
        });

        const {
            pageStates,
            runtime,
        } = createPreviewRuntimeHarness({
            scrollDirection,
            scrollWindowRef,
        });

        await vi.waitFor(() => {
            expect(pageStates.value[0]?.status).toBe('loaded');
            expect(pageStates.value[8]?.status).toBe('loaded');
        });
        expect(previewMocks.renderPageObjectUrl).toHaveBeenCalledWith(9, expect.any(Object));

        scrollWindowRef.value = {
            start: 11,
            end: 11,
            mostVisiblePage: 11,
            pageNumbers: [11],
        };
        runtime.syncLoadedPages();

        await vi.waitFor(() => {
            expect(pageStates.value[10]?.status).toBe('loaded');
        });
        expect(pageStates.value[0]).toMatchObject({
            objectUrl: 'blob:page-1',
            status: 'loaded',
        });

        for (const pageNumber of [
            12,
            13,
            14,
            15,
        ]) {
            scrollWindowRef.value = {
                start: pageNumber,
                end: pageNumber,
                mostVisiblePage: pageNumber,
                pageNumbers: [pageNumber],
            };
            runtime.syncLoadedPages();
        }

        expect(pageStates.value[0]).toMatchObject({
            objectUrl: null,
            status: 'idle',
        });

        runtime.dispose();
    });

    it('does not retain large recently rendered previews beyond the pixel budget', async () => {
        previewMocks.getPageSizes.mockResolvedValue(Array.from({ length: 20 }, () => ({
            width: 5_000,
            height: 5_000,
        })));
        previewMocks.renderPageObjectUrl.mockImplementation(async (pageNumber: number) => ({
            objectUrl: `blob:large-page-${pageNumber}`,
            renderedPx: 5_000,
        }));
        const scrollWindowRef = ref({
            start: 1,
            end: 1,
            mostVisiblePage: 1,
            pageNumbers: [1],
        });
        const {
            pageStates,
            runtime,
        } = createPreviewRuntimeHarness({
            neededDeviceWidth: 5_000,
            scrollWindowRef,
        });

        await vi.waitFor(() => expect(pageStates.value[0]?.objectUrl).toBe('blob:large-page-1'));

        scrollWindowRef.value = {
            start: 20,
            end: 20,
            mostVisiblePage: 20,
            pageNumbers: [20],
        };
        runtime.syncLoadedPages();

        await vi.waitFor(() => expect(pageStates.value[19]?.objectUrl).toBe('blob:large-page-20'));
        expect(pageStates.value[0]).toMatchObject({
            objectUrl: null,
            status: 'idle',
        });

        runtime.dispose();
    });

    it('uses coarse preview renders while scrolling and refreshes after scroll settles', async () => {
        previewMocks.getPageSizes.mockResolvedValue(Array.from({ length: 12 }, () => ({
            width: 2_400,
            height: 3_200,
        })));
        previewMocks.renderPageObjectUrl.mockImplementation(async (pageNumber: number, options?: {subsample?: number}) => {
            const subsample = options?.subsample ?? 1;
            return {
                objectUrl: `blob:page-${pageNumber}-${subsample}`,
                renderedPx: Math.round(2_400 / subsample),
            };
        });
        const scrollWindowRef = ref({
            start: 1,
            end: 1,
            mostVisiblePage: 1,
            pageNumbers: [1],
        });
        const {
            pageStates,
            runtime,
        } = createPreviewRuntimeHarness({
            neededDeviceWidth: 2_000,
            scrollWindowRef,
        });

        await vi.waitFor(() => expect(pageStates.value[0]?.objectUrl).toBe('blob:page-1-2'));
        expect(previewMocks.renderPageObjectUrl).toHaveBeenCalledWith(1, { subsample: 2 });

        scrollWindowRef.value = {
            start: 10,
            end: 10,
            mostVisiblePage: 10,
            pageNumbers: [10],
        };
        runtime.scheduleScrollSettledPreviewRerender();
        runtime.syncLoadedPages();

        await vi.waitFor(() => expect(pageStates.value[9]?.objectUrl).toBe('blob:page-10-3'));
        expect(previewMocks.renderPageObjectUrl).toHaveBeenCalledWith(10, { subsample: 3 });

        await new Promise(resolve => setTimeout(resolve, 220));

        await vi.waitFor(() => expect(previewMocks.renderPageObjectUrl).toHaveBeenCalledWith(10, { subsample: 2 }));

        runtime.dispose();
    });

    it('skips high-resolution decode commits that complete during active scrolling', async () => {
        const neededDeviceWidth = ref(500);
        const highResolutionRender = createDeferred<{
            objectUrl: string;
            renderedPx: number;
        }>();
        previewMocks.getPageSizes.mockResolvedValue([{
            width: 2_400,
            height: 3_200,
        }]);
        previewMocks.renderPageObjectUrl.mockImplementation((pageNumber: number, options?: {subsample?: number}) => {
            const subsample = options?.subsample ?? 1;
            if (subsample === 2) {
                return highResolutionRender.promise;
            }

            return Promise.resolve({
                objectUrl: `blob:page-${pageNumber}-${subsample}`,
                renderedPx: Math.round(2_400 / subsample),
            });
        });
        const {
            pageStates,
            runtime,
        } = createPreviewRuntimeHarness({ neededDeviceWidth: () => neededDeviceWidth.value });

        await vi.waitFor(() => expect(pageStates.value[0]?.objectUrl).toBe('blob:page-1-3'));
        expect(pageStates.value[0]?.renderedPx).toBe(800);

        neededDeviceWidth.value = 2_000;
        runtime.syncLoadedPages();
        await vi.waitFor(() => expect(previewMocks.renderPageObjectUrl).toHaveBeenCalledWith(1, { subsample: 2 }));

        runtime.scheduleScrollSettledPreviewRerender();
        highResolutionRender.resolve({
            objectUrl: 'blob:page-1-2',
            renderedPx: 1_200,
        });

        await vi.waitFor(() => expect(previewMocks.revokeObjectURL).toHaveBeenCalledWith('blob:page-1-2'));
        expect(pageStates.value[0]).toMatchObject({
            objectUrl: 'blob:page-1-3',
            renderedPx: 800,
            status: 'loaded',
        });

        runtime.dispose();
    });
});
