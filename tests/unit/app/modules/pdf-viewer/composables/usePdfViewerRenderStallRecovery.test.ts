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
    it('trips the heartbeat circuit breaker without starting a retry timer or reload', () => {
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
        expect(renderVisiblePages).not.toHaveBeenCalled();
        expect(scheduleReload).not.toHaveBeenCalled();
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
