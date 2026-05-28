import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';

const resizeObserverMock = vi.hoisted(() => ({callback: null as (() => void) | null}));
const captureScrollSnapshotMock = vi.hoisted(() => vi.fn(() => ({anchorPage: 3})));

vi.mock('@vueuse/core', async () => {
    const actual = await vi.importActual('@vueuse/core');
    return {
        ...actual,
        useResizeObserver: vi.fn((_target, callback) => {
            resizeObserverMock.callback = callback;
            return {stop: vi.fn()};
        }),
    };
});

vi.mock('@app/composables/pdf/pdfPageRenderPipeline', () => ({
    captureScrollSnapshot: captureScrollSnapshotMock,
    restoreScrollFromSnapshot: vi.fn(),
}));

const { usePdfViewerResizeLifecycle } = await import(
    '@app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle'
);

function createResizeLifecycle(
    isActive = ref(true),
    options?: { computeFitWidthScale?: () => boolean; },
) {
    const getMostVisiblePage = vi.fn(() => 2);
    const computeFitWidthScale = vi.fn(options?.computeFitWidthScale ?? (() => true));
    const scheduleResizeAwareRerender = vi.fn();
    const setResizeTransitionVisible = vi.fn();
    const lifecycle = usePdfViewerResizeLifecycle({
        viewerContainer: ref(null),
        isLoading: ref(false),
        isActive,
        isResizing: ref(false),
        pdfDocument: ref({}),
        currentPage: ref(4),
        visibleRange: ref({
            start: 4,
            end: 5,
        }),
        numPages: ref(10),
        computeFitWidthScale,
        getMostVisiblePage,
        summarizeViewerMetricsForLog: vi.fn(() => null),
        summarizeVisiblePageSnapshotForLog: vi.fn(() => ({})),
        scheduleResizeAwareRerender,
        setResizeTransitionVisible,
    });

    return {
        computeFitWidthScale,
        getMostVisiblePage,
        isActive,
        lifecycle,
        scheduleResizeAwareRerender,
        setResizeTransitionVisible,
    };
}

describe('usePdfViewerResizeLifecycle inactive behavior', () => {
    afterEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        resizeObserverMock.callback = null;
    });

    it('builds an inactive anchor context without reading DOM snapshots', () => {
        const {
            getMostVisiblePage,
            lifecycle,
        } = createResizeLifecycle(ref(false));

        const anchor = lifecycle.buildResizeAnchorContext();

        expect(anchor.snapshot).toBeNull();
        expect(anchor.page).toBe(4);
        expect(captureScrollSnapshotMock).not.toHaveBeenCalled();
        expect(getMostVisiblePage).not.toHaveBeenCalled();
    });

    it('ignores resize observer callbacks while inactive', () => {
        const {
            computeFitWidthScale,
            scheduleResizeAwareRerender,
            setResizeTransitionVisible,
        } = createResizeLifecycle(ref(false));

        resizeObserverMock.callback?.();

        expect(computeFitWidthScale).not.toHaveBeenCalled();
        expect(scheduleResizeAwareRerender).not.toHaveBeenCalled();
        expect(setResizeTransitionVisible).not.toHaveBeenCalled();
    });

    it('cancels pending resize rerenders when inactive before debounce settles', async () => {
        vi.useFakeTimers();
        const {
            isActive,
            scheduleResizeAwareRerender,
            setResizeTransitionVisible,
        } = createResizeLifecycle(ref(true));

        resizeObserverMock.callback?.();
        isActive.value = false;

        await vi.advanceTimersByTimeAsync(400);

        expect(scheduleResizeAwareRerender).not.toHaveBeenCalled();
        expect(setResizeTransitionVisible).toHaveBeenCalledWith({
            active: false,
            source: 'resize-cancelled',
            token: 1,
            anchorPage: 4,
        });
    });

    it('does not schedule a resize rerender when fit geometry is unchanged', async () => {
        vi.useFakeTimers();
        const {
            computeFitWidthScale,
            scheduleResizeAwareRerender,
            setResizeTransitionVisible,
        } = createResizeLifecycle(ref(true), { computeFitWidthScale: () => false });

        resizeObserverMock.callback?.();

        await vi.advanceTimersByTimeAsync(400);

        expect(computeFitWidthScale).toHaveBeenCalledOnce();
        expect(scheduleResizeAwareRerender).not.toHaveBeenCalled();
        expect(setResizeTransitionVisible).not.toHaveBeenCalled();
    });
});
