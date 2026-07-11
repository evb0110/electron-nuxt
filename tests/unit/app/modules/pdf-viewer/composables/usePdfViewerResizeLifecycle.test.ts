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

const { usePdfViewerResizeLifecycle } = await import(
    '@app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle'
);

type TResizeLifecycleOptions = Parameters<typeof usePdfViewerResizeLifecycle>[0];

function createResizeLifecycle(
    isActive = ref(true),
    options?: {
        computeFitWidthScale?: () => boolean;
        isResizing?: Ref<boolean>;
        pendingNavigationAnchorPage?: Readonly<Ref<number | null>>;
        transactionController?: TResizeLifecycleOptions['transactionController'];
        captureViewportAnchor?: TResizeLifecycleOptions['captureViewportAnchor'];
    },
) {
    const getMostVisiblePage = vi.fn(() => 2);
    const computeFitWidthScale = vi.fn(options?.computeFitWidthScale ?? (() => true));
    const scheduleResizeAwareRerender = vi.fn();
    const setResizeTransitionVisible = vi.fn();
    const submitResizeIntent = vi.fn();
    const isResizing = options?.isResizing ?? ref(false);
    const lifecycle = usePdfViewerResizeLifecycle({
        submitResizeIntent,
        viewerContainer: ref(null),
        isLoading: ref(false),
        isActive,
        isResizing,
        pdfDocument: ref({}),
        currentPage: ref(4),
        pendingNavigationAnchorPage: options?.pendingNavigationAnchorPage,
        visibleRange: ref({
            start: 4,
            end: 5,
        }),
        numPages: ref(10),
        computeFitWidthScale,
        clearPreviewFitScale: vi.fn(),
        captureViewportAnchor: options?.captureViewportAnchor,
        getMostVisiblePage,
        summarizeViewerMetricsForLog: vi.fn(() => null),
        summarizeVisiblePageSnapshotForLog: vi.fn(() => ({})),
        scheduleResizeAwareRerender,
        setResizeTransitionVisible,
        transactionController: options?.transactionController,
    });

    return {
        computeFitWidthScale,
        getMostVisiblePage,
        isActive,
        isResizing,
        lifecycle,
        scheduleResizeAwareRerender,
        setResizeTransitionVisible,
        submitResizeIntent,
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

        expect(anchor.page).toBe(4);
        expect(getMostVisiblePage).not.toHaveBeenCalled();
    });

    it('does not force an untrusted preferred page into the initial anchor snapshot', () => {
        const { lifecycle } = createResizeLifecycle(ref(true));

        const anchor = lifecycle.buildResizeAnchorContext({
            preferredAnchorPage: 9,
            trustPreferredAnchorPage: false,
        });

        expect(anchor.page).toBe(4);
    });

    it('uses a trusted preferred page as the initial anchor snapshot', () => {
        const { lifecycle } = createResizeLifecycle(ref(true));

        const anchor = lifecycle.buildResizeAnchorContext({
            preferredAnchorPage: 9,
            trustPreferredAnchorPage: true,
        });

        expect(anchor.page).toBe(9);
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

    it('refreshes render demand when viewport geometry changes without a fit-scale delta', async () => {
        vi.useFakeTimers();
        const {
            computeFitWidthScale,
            scheduleResizeAwareRerender,
            setResizeTransitionVisible,
        } = createResizeLifecycle(ref(true), { computeFitWidthScale: () => false });

        resizeObserverMock.callback?.();

        await vi.advanceTimersByTimeAsync(400);

        expect(computeFitWidthScale).toHaveBeenCalledOnce();
        expect(scheduleResizeAwareRerender).toHaveBeenCalledOnce();
        expect(setResizeTransitionVisible).toHaveBeenCalledWith(expect.objectContaining({
            active: true,
            anchorPage: 4,
            source: 'resize-observer',
        }));
    });

    it('uses a pending navigation page as the resize observer anchor', async () => {
        vi.useFakeTimers();
        const {
            scheduleResizeAwareRerender,
            setResizeTransitionVisible,
            submitResizeIntent,
        } = createResizeLifecycle(ref(true), { pendingNavigationAnchorPage: ref(8) });

        resizeObserverMock.callback?.();

        await vi.advanceTimersByTimeAsync(400);

        expect(submitResizeIntent).toHaveBeenCalledOnce();
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

    it('attaches resize observer transactions to scheduled rerenders', async () => {
        vi.useFakeTimers();
        const beginTransaction = vi.fn(() => ({
            id: 12,
            kind: 'resize' as const,
            source: 'resize-observer' as const,
            state: 'preparing' as const,
            documentRef: {
                document: null,
                documentLoadToken: 0,
                documentVersion: 0,
            },
            target: null,
            fitPlan: {
                mode: 'none' as const,
                scalePage: null,
                hydrateRange: null,
                viewMode: null,
                pagedTargetRenderHandoff: null,
            },
            scrollPlan: null,
            renderRequest: null,
            createdAtMs: 0,
            userViewportInteractionEpoch: 0,
            cancellation: null,
        }));
        const transactionController: NonNullable<TResizeLifecycleOptions['transactionController']> = {
            beginTransaction,
            cancelActiveTransaction: vi.fn(() => true),
            isTransactionCurrent: vi.fn(() => true),
        };
        const {scheduleResizeAwareRerender} = createResizeLifecycle(ref(true), { transactionController });

        resizeObserverMock.callback?.();

        await vi.advanceTimersByTimeAsync(400);

        expect(beginTransaction).toHaveBeenCalledWith({
            kind: 'resize',
            source: 'resize-observer',
            page: 4,
            range: {
                start: 4,
                end: 5,
            },
            anchor: 'center',
        });
        expect(scheduleResizeAwareRerender).toHaveBeenCalledWith(
            're-render visible pages after resize',
            expect.objectContaining({ transactionId: 12 }),
        );
    });

    it('previews throughout a drag and performs exactly one anchored settle', async () => {
        vi.useFakeTimers();
        const semanticAnchor = {
            affinity: 'center' as const,
            page: 4,
            pageXFraction: 0.35,
            pageYFraction: 0.72,
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
        };
        const isResizing = ref(false);
        const {
            computeFitWidthScale,
            scheduleResizeAwareRerender,
            submitResizeIntent,
        } = createResizeLifecycle(ref(true), {
            captureViewportAnchor: () => semanticAnchor,
            isResizing,
        });

        isResizing.value = true;
        resizeObserverMock.callback?.();
        resizeObserverMock.callback?.();

        expect(computeFitWidthScale).toHaveBeenCalledWith(null, {
            page: 4,
            preview: true,
        });
        expect(scheduleResizeAwareRerender).not.toHaveBeenCalled();

        isResizing.value = false;
        resizeObserverMock.callback?.();
        await vi.advanceTimersByTimeAsync(25);

        expect(submitResizeIntent).toHaveBeenCalledOnce();
        expect(submitResizeIntent).toHaveBeenCalledWith(semanticAnchor);
        expect(scheduleResizeAwareRerender).toHaveBeenCalledOnce();
        expect(scheduleResizeAwareRerender).toHaveBeenCalledWith(
            're-render visible pages after resize settle',
            expect.objectContaining({
                resizeAnchor: expect.objectContaining({
                    page: 4,
                    semanticAnchor,
                }),
                source: 'resize-settle',
            }),
        );

        await vi.advanceTimersByTimeAsync(400);
        expect(scheduleResizeAwareRerender).toHaveBeenCalledOnce();
    });
});
