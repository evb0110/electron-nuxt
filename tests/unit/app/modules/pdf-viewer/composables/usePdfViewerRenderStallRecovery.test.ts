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
import { usePdfViewerRenderStallRecovery } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerRenderStallRecovery';
import {
    createPdfRenderSupervisor,
    type IPdfRenderSupervisorEvent,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';

describe('usePdfViewerRenderStallRecovery', () => {
    it('invalidates stalled pages and retries page render when rendering stalls', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(10_000);
            const scheduleReload = vi.fn();
            const cancelInFlightPageRenders = vi.fn();
            const renderVisiblePages = vi.fn().mockResolvedValue(undefined);
            const supervisorEvents: IPdfRenderSupervisorEvent[] = [];
            const renderSupervisor = createPdfRenderSupervisor({ onEvent: event => supervisorEvents.push(event) });
            const recovery = usePdfViewerRenderStallRecovery({
                src: computed(
                    () => ({
                        kind: 'path' as const,
                        path: '/tmp/test.pdf',
                        size: 1,
                    }),
                ),
                isLoading: ref(false),
                isAnySaving: ref(false),
                numPages: ref(3),
                currentPage: ref(2),
                visibleRange: ref({
                    start: 1,
                    end: 3,
                }),
                viewerContainer: ref(null),
                summarizeViewerMetricsForLog: () => ({ visiblePages: [
                    1,
                    2,
                ] }),
                cancelInFlightPageRenders,
                renderVisiblePages,
                scheduleReload,
                renderSupervisor,
            });

            recovery.handlePageRenderStall({
                pageNumber: 2,
                stage: 'canvas-render',
                timeoutMs: 15_000,
            });

            vi.runAllTimers();
            await Promise.resolve();

            expect(cancelInFlightPageRenders).toHaveBeenCalledOnce();
            expect(renderVisiblePages).toHaveBeenCalledWith(
                {
                    start: 2,
                    end: 2,
                },
                {
                    preserveRenderedPages: true,
                    forceRerender: true,
                    bufferOverride: 0,
                },
            );
            expect(scheduleReload).not.toHaveBeenCalled();
            expect(recovery.consumePendingInvalidation()).toEqual([2]);
            expect(recovery.consumePendingInvalidation()).toBeNull();
            expect(supervisorEvents).toContainEqual(expect.objectContaining({
                cause: 'render-stall-recovery',
                metadata: expect.objectContaining({
                    queuedPage: 2,
                    stage: 'canvas-render',
                    timeoutMs: 15_000,
                }),
            }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('skips stalled page recovery while a save is in progress', () => {
        vi.useFakeTimers();
        try {
            const scheduleReload = vi.fn();
            const cancelInFlightPageRenders = vi.fn();
            const renderVisiblePages = vi.fn().mockResolvedValue(undefined);
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
                renderVisiblePages,
                scheduleReload,
            });

            recovery.handlePageRenderStall({
                pageNumber: 1,
                stage: 'canvas-render',
                timeoutMs: 15_000,
            });

            vi.runAllTimers();

            expect(cancelInFlightPageRenders).not.toHaveBeenCalled();
            expect(renderVisiblePages).not.toHaveBeenCalled();
            expect(scheduleReload).not.toHaveBeenCalled();
            expect(recovery.consumePendingInvalidation()).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels pending stalled recovery work when reset', async () => {
        vi.useFakeTimers();
        try {
            const scheduleReload = vi.fn();
            const cancelInFlightPageRenders = vi.fn();
            const renderVisiblePages = vi.fn().mockRejectedValue(new Error('stale failure'));
            const recovery = usePdfViewerRenderStallRecovery({
                src: computed(
                    () => ({
                        kind: 'path' as const,
                        path: '/tmp/test.pdf',
                        size: 1,
                    }),
                ),
                isLoading: ref(false),
                isAnySaving: ref(false),
                numPages: ref(3),
                currentPage: ref(1),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                viewerContainer: ref(null),
                summarizeViewerMetricsForLog: () => null,
                cancelInFlightPageRenders,
                renderVisiblePages,
                scheduleReload,
            });

            recovery.handlePageRenderStall({
                pageNumber: 1,
                stage: 'canvas-render',
                timeoutMs: 15_000,
            });
            vi.runAllTimers();
            recovery.resetRenderStallRecoveryState();
            await Promise.resolve();

            expect(renderVisiblePages).toHaveBeenCalledOnce();
            expect(scheduleReload).not.toHaveBeenCalled();
            expect(recovery.consumePendingInvalidation()).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});
