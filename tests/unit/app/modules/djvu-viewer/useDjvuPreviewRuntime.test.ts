import {
    computed,
    nextTick,
    ref,
} from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IDjvuPageSize } from '@app/platform/browser-api/public';
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

vi.mock('@app/platform/browser-api/public', () => ({ createDjvuPagePreviewSourceFromPath: previewMocks.createDjvuPagePreviewSourceFromPath }));

class InstantImage {
    public onerror: (() => void) | null = null;
    public onload: (() => void) | null = null;

    public set src(_value: string) {
        queueMicrotask(() => this.onload?.());
    }
}

function createPreviewRuntimeHarness(options: { isActive?: boolean } = {}) {
    const src = ref('fixture.djvu');
    const isActiveSource = ref(options.isActive ?? true);
    const pageSizes = ref<IDjvuPageSize[]>([]);
    const pageStates = ref<IDjvuPageState[]>([]);
    const currentPage = ref(1);
    const emittedTotalPages: number[] = [];
    const runtime = useDjvuPreviewRuntime({
        state: {
            currentPage,
            isLoading: ref(Boolean(src.value)),
            pageSizes,
            pageStates,
            viewerError: ref(null),
        },
        source: {
            getNeededDeviceWidth: () => 100,
            getOpenErrorMessage: () => 'open failed',
            getSrc: () => src.value,
            isActive: computed(() => isActiveSource.value),
            isContinuousScroll: computed(() => true),
            resolveContinuousScrollWindow: () => ({
                start: 1,
                end: 1,
                mostVisiblePage: 1,
                pageNumbers: [1],
            }),
            scrollDirection: ref(0),
            totalPages: computed(() => pageSizes.value.length),
        },
        effects: {
            clearPageElements: vi.fn(),
            emitCurrentPage: vi.fn(),
            emitDocument: vi.fn(),
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
        emittedTotalPages,
        isActiveSource,
        pageStates,
        runtime,
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
        previewMocks.renderPageObjectUrl.mockResolvedValue({
            objectUrl: 'blob:page-1',
            renderedPx: 100,
        });
        previewMocks.createDjvuPagePreviewSourceFromPath.mockResolvedValue({
            getPageSizes: previewMocks.getPageSizes,
            renderPageObjectUrl: previewMocks.renderPageObjectUrl,
            revokeObjectURL: previewMocks.revokeObjectURL,
            terminate: previewMocks.terminate,
        });
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
});
