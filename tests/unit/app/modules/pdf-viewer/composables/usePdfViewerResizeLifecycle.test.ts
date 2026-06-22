import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { Ref } from 'vue';
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

vi.mock('@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/captureScrollSnapshot', () => ({captureScrollSnapshot: captureScrollSnapshotMock}));

vi.mock('@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/restoreScrollFromSnapshot', () => ({restoreScrollFromSnapshot: vi.fn()}));

const { usePdfViewerResizeLifecycle } = await import(
    '@app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle'
);

function createResizeLifecycle(
    isActive = ref(true),
    options?: {
        computeFitWidthScale?: () => boolean;
        pendingNavigationAnchorPage?: Readonly<Ref<number | null>>;
    },
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
        pendingNavigationAnchorPage: options?.pendingNavigationAnchorPage,
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

    it('does not force an untrusted preferred page into the initial anchor snapshot', () => {
        const { lifecycle } = createResizeLifecycle(ref(true));

        const anchor = lifecycle.buildResizeAnchorContext({
            anchorViewportX: 64,
            anchorViewportY: 72,
            preferredAnchorPage: 9,
            trustPreferredAnchorPage: false,
        });

        expect(anchor.page).toBe(4);
        expect(captureScrollSnapshotMock).toHaveBeenNthCalledWith(1, null, {
            anchorViewportX: 64,
            anchorViewportY: 72,
            preferredAnchorPage: null,
        });
        expect(captureScrollSnapshotMock).toHaveBeenNthCalledWith(2, null, {
            anchorViewportX: 64,
            anchorViewportY: 72,
            preferredAnchorPage: 4,
        });
    });

    it('drops a forced preferred anchor snapshot when the captured page disagrees', () => {
        const { lifecycle } = createResizeLifecycle(ref(true));

        const anchor = lifecycle.buildResizeAnchorContext({
            forcePreferredAnchorPage: true,
            preferredAnchorPage: 9,
            trustPreferredAnchorPage: true,
        });

        expect(anchor.page).toBe(9);
        expect(anchor.snapshot).toBeNull();
        expect(captureScrollSnapshotMock).toHaveBeenNthCalledWith(1, null, {
            anchorViewportX: null,
            anchorViewportY: null,
            preferredAnchorPage: 9,
        });
        expect(captureScrollSnapshotMock).toHaveBeenNthCalledWith(2, null, {
            anchorViewportX: null,
            anchorViewportY: null,
            preferredAnchorPage: 9,
        });
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

    it('uses a pending navigation page as the resize observer anchor', async () => {
        vi.useFakeTimers();
        const {
            scheduleResizeAwareRerender,
            setResizeTransitionVisible,
        } = createResizeLifecycle(ref(true), { pendingNavigationAnchorPage: ref(8) });

        resizeObserverMock.callback?.();

        await vi.advanceTimersByTimeAsync(400);

        expect(captureScrollSnapshotMock).toHaveBeenNthCalledWith(1, null, {
            anchorViewportX: null,
            anchorViewportY: null,
            preferredAnchorPage: 8,
        });
        expect(captureScrollSnapshotMock).toHaveBeenNthCalledWith(2, null, {
            anchorViewportX: null,
            anchorViewportY: null,
            preferredAnchorPage: 8,
        });
        expect(setResizeTransitionVisible).toHaveBeenCalledWith({
            active: true,
            source: 'resize-observer',
            token: 1,
            anchorPage: 8,
        });
        expect(scheduleResizeAwareRerender).toHaveBeenCalledWith(
            're-render visible pages after resize',
            expect.objectContaining({
                resizeAnchor: expect.objectContaining({ page: 8 }),
                source: 'resize-observer',
                stabilize: true,
            }),
        );
    });
});
