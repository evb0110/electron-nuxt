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
import { usePdfViewerRenderStallRecovery } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerRenderStallRecovery';

describe('usePdfViewerRenderStallRecovery', () => {
    it('skips stalled page recovery while a save is in progress', () => {
        vi.useFakeTimers();
        try {
            const scheduleReload = vi.fn();
            const cancelInFlightPageRenders = vi.fn();
            const recovery = usePdfViewerRenderStallRecovery({
                src: computed(
                    () => ({
                        kind: 'path' as const,
                        path: '/tmp/test.pdf',
                        size: 1,
                    }),
                ),
                isLoading: ref(false),
                isAnySaving: ref(true),
                numPages: ref(3),
                currentPage: ref(1),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                viewerContainer: ref(null),
                summarizeViewerMetricsForLog: () => null,
                cancelInFlightPageRenders,
                scheduleReload,
            });

            recovery.handlePageRenderStall({
                pageNumber: 1,
                stage: 'canvas-render',
                timeoutMs: 15_000,
            });

            vi.runAllTimers();

            expect(cancelInFlightPageRenders).not.toHaveBeenCalled();
            expect(scheduleReload).not.toHaveBeenCalled();
            expect(recovery.consumePendingInvalidation()).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});
