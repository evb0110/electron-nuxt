import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IScanCleanupCapability,
    TScanCleanupJobState,
} from '@contracts/electronApiScanCleanup';

const capability = vi.hoisted(() => ({value: null as IScanCleanupCapability | null}));

vi.mock('@app/utils/getScanCleanupCapability', () => ({getScanCleanupCapability: () => capability.value}));

function progress(processedCount = 0, totalPages = 4) {
    return {
        phase: 'cleaning' as const,
        processedCount,
        totalPages,
        percent: processedCount / totalPages * 100,
    };
}

describe('scan cleanup run coordinator', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('keeps runs global and routes completed, failed, and canceled terminal states', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        let nextJob = 0;
        capability.value = {
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            start: vi.fn(async () => ({
                started: true,
                jobId: `job-${++nextJob}`,
                outputPdfPath: '/managed/book — cleaned.pdf',
            })),
            cancel: vi.fn(async () => true),
            getJobState: vi.fn(async () => null),
            subscribeJob: vi.fn(async jobId => ({
                jobId,
                status: 'running' as const,
                progress: progress(),
                updatedAtMs: Date.now(),
            })),
            reconnectJob: vi.fn(async () => null),
            pruneGeneratedOutputs: vi.fn(async () => 0),
            onJobState: vi.fn(callback => {
                listener = callback;
                return () => { listener = () => undefined; };
            }),
        };
        const openGeneratedPdf = vi.fn(async () => true);
        const saveActiveDocumentAs = vi.fn(async () => true);
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf,
            saveActiveDocumentAs,
            getOpenPdfPaths: () => ['/managed/already-open.pdf'],
            t: ((key: string) => key) as never,
            toast: {add: toastAdd},
        });

        await coordinator.startScanCleanup({
            sourcePdfPath: '/source/book.pdf',
            options: {
                layoutMode: 'auto',
                outputMode: 'bw',
                thickness: 0,
                crop: true,
                matchPageSize: true,
                pageAlignment: 'top-center',
                marginsMm: 5,
                despeckle: true,
            },
        });
        expect(capability.value.start).toHaveBeenCalledWith(expect.not.objectContaining({outputPdfPath: expect.anything()}));
        listener({
            jobId: 'job-1',
            status: 'completed',
            outputPdfPath: '/managed/book — cleaned.pdf',
            summary: {
                inputPages: 4,
                outputPages: 8,
                spreadsSplit: 4,
                offcutsDiscarded: 0,
                deskewSkipped: 0,
                cropSkipped: 0,
                warnings: [],
            },
            progress: progress(4),
            updatedAtMs: Date.now(),
        });
        await vi.waitFor(() => expect(openGeneratedPdf).toHaveBeenCalledWith('/managed/book — cleaned.pdf'));
        const completeToast = toastAdd.mock.calls.at(-1)?.[0];
        completeToast.actions[0].onClick();
        expect(saveActiveDocumentAs).toHaveBeenCalledOnce();

        await coordinator.startScanCleanup({
            sourcePdfPath: '/source/book.pdf',
            options: expect.anything() as never,
        });
        coordinator.scanCleanupRun.dialogOpen = false;
        listener({
            jobId: 'job-2',
            status: 'failed',
            error: 'sidecar failed',
            errorCode: 'sidecar-failed',
            progress: progress(1),
            updatedAtMs: Date.now(),
        });
        await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({color: 'error'})));
        const failureToast = toastAdd.mock.calls.at(-1)?.[0];
        failureToast.actions[0].onClick();
        expect(coordinator.scanCleanupRun.openRequestRevision).toBe(1);

        await coordinator.startScanCleanup({
            sourcePdfPath: '/source/book.pdf',
            options: expect.anything() as never,
        });
        listener({
            jobId: 'job-3',
            status: 'canceled',
            progress: progress(1),
            updatedAtMs: Date.now(),
        });
        await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({color: 'info'})));
        expect(openGeneratedPdf).toHaveBeenCalledOnce();
        cleanup();
    });
});
