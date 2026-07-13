import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
} from 'vue';
import {usePdfViewerRenderStallRecovery} from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerRenderStallRecovery';

function setup() {
    const cancelInFlightPageRenders = vi.fn();
    const renderVisiblePages = vi.fn().mockResolvedValue(undefined);
    const scheduleReload = vi.fn();
    const recovery = usePdfViewerRenderStallRecovery({
        src: computed(() => ({
            kind: 'path' as const,
            path: '/tmp/test.pdf',
            size: 1,
        })),
        isLoading: ref(false),
        isAnySaving: ref(false),
        numPages: ref(3),
        currentPage: ref(2),
        visibleRange: ref({
            start: 1,
            end: 3,
        }),
        viewerContainer: ref(null),
        summarizeViewerMetricsForLog: () => ({visiblePages: [
            1,
            2,
        ]}),
        cancelInFlightPageRenders,
        renderVisiblePages,
        scheduleReload,
    });
    return {
        cancelInFlightPageRenders,
        recovery,
        renderVisiblePages,
        scheduleReload,
    };
}

describe('usePdfViewerRenderStallRecovery', () => {
    it('forces a bounded page render when the heartbeat circuit breaker trips', async () => {
        const {
            cancelInFlightPageRenders,
            recovery,
            renderVisiblePages,
            scheduleReload,
        } = setup();

        recovery.handlePageRenderStall({
            pageNumber: 2,
            stage: 'canvas-render' as const,
            timeoutMs: 15_000,
        });

        expect(cancelInFlightPageRenders).toHaveBeenCalledOnce();
        expect(recovery.consumePendingInvalidation()).toEqual([2]);
        expect(renderVisiblePages).toHaveBeenCalledExactlyOnceWith({
            start: 2,
            end: 2,
        }, {
            preserveRenderedPages: true,
            forceRerender: true,
            bufferOverride: 0,
        });
        expect(scheduleReload).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(renderVisiblePages).toHaveBeenCalledOnce());
    });

    it('reloads only when the bounded page render fails', async () => {
        const {
            recovery,
            renderVisiblePages,
            scheduleReload,
        } = setup();
        renderVisiblePages.mockRejectedValueOnce(new Error('stalled again'));

        recovery.handlePageRenderStall({
            pageNumber: 2,
            stage: 'canvas-render',
            timeoutMs: 15_000,
        });

        await vi.waitFor(() => expect(scheduleReload).toHaveBeenCalledExactlyOnceWith(true));
    });

    it('deduplicates repeated heartbeat failures until reset', () => {
        const {
            cancelInFlightPageRenders,
            recovery,
        } = setup();
        const payload = {
            pageNumber: 2,
            stage: 'canvas-render' as const,
            timeoutMs: 15_000,
        };

        recovery.handlePageRenderStall(payload);
        recovery.handlePageRenderStall(payload);
        expect(cancelInFlightPageRenders).toHaveBeenCalledOnce();

        recovery.resetRenderStallRecoveryState();
        recovery.handlePageRenderStall(payload);
        expect(cancelInFlightPageRenders).toHaveBeenCalledTimes(2);
    });

    it('ignores heartbeat failures while loading or without a document', () => {
        const cancelInFlightPageRenders = vi.fn();
        const recovery = usePdfViewerRenderStallRecovery({
            src: computed(() => null),
            isLoading: ref(true),
            numPages: ref(0),
            currentPage: ref(1),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            viewerContainer: ref(null),
            summarizeViewerMetricsForLog: () => null,
            cancelInFlightPageRenders,
            renderVisiblePages: vi.fn().mockResolvedValue(undefined),
            scheduleReload: vi.fn(),
        });

        recovery.handlePageRenderStall({
            pageNumber: 1,
            stage: 'canvas-render',
            timeoutMs: 1,
        });
        expect(cancelInFlightPageRenders).not.toHaveBeenCalled();
        expect(recovery.consumePendingInvalidation()).toBeNull();
    });
});
