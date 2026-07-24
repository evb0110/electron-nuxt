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
        stage: 'rendering' as const,
        completedUnits: processedCount,
        totalUnits: totalPages,
        percent: processedCount / totalPages * 100,
        completedPageNumbers: Array.from({length: processedCount}, (_, index) => index + 1),
    };
}

const ownerContext = {
    ownerId: 'scan-cleanup-test-owner',
    documentRevision: 'scan-cleanup-test-revision',
};

describe('scan cleanup run coordinator', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('keeps a pending start single-flight across rapid callers', async () => {
        const pendingStart = Promise.withResolvers<{
            started: true;
            jobId: string;
            outputPdfPath: string;
        }>();
        capability.value = {
            preview: vi.fn(),
            previewRaw: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(() => pendingStart.promise),
            cancel: vi.fn(),
            getJobState: vi.fn(),
            subscribeJob: vi.fn(async jobId => ({
                jobId,
                status: 'running' as const,
                progress: progress(),
                updatedAtMs: Date.now(),
            })),
            reconnectJob: vi.fn(),
            pruneGeneratedOutputs: vi.fn(),
            onJobState: vi.fn(() => () => undefined),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const request = {
            ...ownerContext,
            sourcePdfPath: '/source/book.pdf',
            options: expect.anything() as never,
        };

        const first = coordinator.startScanCleanup(request);
        const second = coordinator.startScanCleanup(request);
        expect(capability.value.start).toHaveBeenCalledOnce();
        expect(coordinator.isScanCleanupRunning.value).toBe(true);

        pendingStart.resolve({
            started: true,
            jobId: 'single-flight-job',
            outputPdfPath: '/managed/single-flight.pdf',
        });
        await expect(first).resolves.toEqual(await second);
        expect(capability.value.start).toHaveBeenCalledOnce();
    });

    it('exposes a run error only to its owning surface', async () => {
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');

        coordinator.setScanCleanupRunError('owner-a', 'native cleanup failed');

        expect(coordinator.getScanCleanupRunError('owner-a')).toBe('native cleanup failed');
        expect(coordinator.getScanCleanupRunError('owner-b')).toBe('');
    });

    it('falls back to a coordinator toast when a thrown start error has no open owning surface', async () => {
        const toastAdd = vi.fn();
        capability.value = {
            preview: vi.fn(),
            previewRaw: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(),
            cancel: vi.fn(),
            getJobState: vi.fn(),
            subscribeJob: vi.fn(),
            reconnectJob: vi.fn(),
            pruneGeneratedOutputs: vi.fn(),
            onJobState: vi.fn(() => () => undefined),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf: vi.fn(),
            saveActiveDocumentAs: vi.fn(),
            openScanCleanupForDocument: vi.fn(),
            getOpenPdfPaths: () => [],
            t: ((key: string) => key) as never,
            toast: {add: toastAdd},
        });

        coordinator.reportScanCleanupRunError(
            'closed-owner',
            'scan-cleanup IPC codec failed',
            '/source/book.pdf',
        );

        expect(coordinator.getScanCleanupRunError('closed-owner')).toBe('scan-cleanup IPC codec failed');
        expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'scanCleanup.failed',
            description: 'scan-cleanup IPC codec failed',
        }));
        cleanup();
    });

    it('keeps runs global and routes completed, failed, and canceled terminal states', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        let nextJob = 0;
        capability.value = {
            preview: vi.fn(),
            previewRaw: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => ({
                started: true as const,
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
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const openGeneratedPdf = vi.fn(async () => true);
        const saveActiveDocumentAs = vi.fn(async () => true);
        const openScanCleanupForDocument = vi.fn(async () => true);
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf,
            saveActiveDocumentAs,
            openScanCleanupForDocument,
            getOpenPdfPaths: () => ['/managed/already-open.pdf'],
            t: ((key: string) => key) as never,
            toast: {add: toastAdd},
        });

        await coordinator.startScanCleanup({
            ...ownerContext,
            sourcePdfPath: '/source/book.pdf',
            options: {
                preserveOriginalQuality: false,
                layoutMode: 'auto',
                outputMode: 'bw',
                readingOrder: 'ltr',
                thickness: 0,
                crop: true,
                matchPageSize: true,
                pageAlignment: 'top-center',
                marginsMm: {
                    leftMm: 5,
                    topMm: 5,
                    rightMm: 5,
                    bottomMm: 5,
                },
                despeckle: true,
                skipBlankPages: false,
                pageOverrides: {},
            },
        });
        expect(capability.value!.start).toHaveBeenCalledWith(expect.not.objectContaining({outputPdfPath: expect.anything()}));
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
                excludedPages: 0,
                blankPagesSkipped: 0,
                warnings: [],
            },
            partial: false,
            progress: progress(4),
            updatedAtMs: Date.now(),
        });
        await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({color: 'success'})));
        expect(openGeneratedPdf).toHaveBeenCalledWith('/managed/book — cleaned.pdf');
        const completeToast = toastAdd.mock.calls.at(-1)?.[0];
        expect(saveActiveDocumentAs).not.toHaveBeenCalled();
        completeToast.actions[0].onClick();
        expect(saveActiveDocumentAs).toHaveBeenCalledOnce();

        await coordinator.startScanCleanup({
            ...ownerContext,
            sourcePdfPath: '/source/book.pdf',
            options: expect.anything() as never,
        });
        coordinator.scanCleanupRun.workspaceOwnerIds.clear();
        listener({
            jobId: 'job-2',
            status: 'failed',
            error: 'sidecar failed',
            errorCode: 'native-failure',
            progress: progress(1),
            updatedAtMs: Date.now(),
        });
        expect(coordinator.getScanCleanupRunError(ownerContext.ownerId)).toBe('sidecar failed');
        expect(coordinator.getScanCleanupRunError('another-owner')).toBe('');
        await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({color: 'error'})));
        const failureToast = toastAdd.mock.calls.at(-1)?.[0];
        failureToast.actions[0].onClick();
        expect(openScanCleanupForDocument).toHaveBeenCalledWith('/source/book.pdf');

        await coordinator.startScanCleanup({
            ...ownerContext,
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

    it('maps out-of-order completion to exact source-page ticks only for that workspace', async () => {
        const {resolveScanCleanupProcessedPages} = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const runningState: TScanCleanupJobState = {
            jobId: 'job-progress',
            status: 'running',
            progress: {
                ...progress(3, 6),
                completedPageNumbers: [
                    5,
                    2,
                    4,
                ],
            },
            updatedAtMs: Date.now(),
        };

        expect([...resolveScanCleanupProcessedPages(
            runningState,
            '/source/book.pdf',
            '/source/book.pdf',
            6,
        )]).toEqual([
            5,
            2,
            4,
        ]);
        expect(resolveScanCleanupProcessedPages(
            runningState,
            '/source/book.pdf',
            '/source/other.pdf',
            6,
        ).size).toBe(0);
        expect(resolveScanCleanupProcessedPages({
            ...runningState,
            status: 'canceled',
        }, '/source/book.pdf', '/source/book.pdf', 6).size).toBe(0);
    });

    it('makes partial-scope completion explicit in the result toast', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        capability.value = {
            preview: vi.fn(),
            previewRaw: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => ({
                started: true as const,
                jobId: 'job-partial',
                outputPdfPath: '/managed/job-partial.pdf',
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
                return () => undefined;
            }),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf: vi.fn(async () => true),
            saveActiveDocumentAs: vi.fn(),
            getOpenPdfPaths: () => [],
            t: ((key: string) => key) as never,
            toast: {add: toastAdd},
        });
        await coordinator.startScanCleanup({
            ...ownerContext,
            sourcePdfPath: '/source/book.pdf',
            options: expect.anything() as never,
            sourcePageNumbers: [3],
        });
        listener({
            jobId: 'job-partial',
            status: 'completed',
            outputPdfPath: '/managed/book-cleaned.pdf',
            summary: {
                inputPages: 1,
                outputPages: 1,
                spreadsSplit: 0,
                offcutsDiscarded: 0,
                deskewSkipped: 0,
                cropSkipped: 0,
                excludedPages: 0,
                blankPagesSkipped: 0,
                warnings: [],
            },
            partial: true,
            progress: progress(1, 1),
            updatedAtMs: Date.now(),
        });
        await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(
            expect.objectContaining({title: 'scanCleanup.completedPartialTitle'}),
        ));
        cleanup();
    });

    it('holds the run guard and active job until the generated PDF finishes opening', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        const openGate = Promise.withResolvers<boolean>();
        capability.value = {
            preview: vi.fn(),
            previewRaw: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => ({
                started: true as const,
                jobId: 'job-open-gate',
                outputPdfPath: '/managed/job-open-gate.pdf',
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
                return () => undefined;
            }),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const openGeneratedPdf = vi.fn(() => openGate.promise);
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf,
            saveActiveDocumentAs: vi.fn(),
            getOpenPdfPaths: () => [],
            t: ((key: string) => key) as never,
            toast: {add: toastAdd},
        });
        await coordinator.startScanCleanup({
            ...ownerContext,
            sourcePdfPath: '/source/book.pdf',
            options: expect.anything() as never,
        });
        const completed: TScanCleanupJobState = {
            jobId: 'job-open-gate',
            status: 'completed',
            outputPdfPath: '/managed/job-open-gate.pdf',
            summary: {
                inputPages: 1,
                outputPages: 1,
                spreadsSplit: 0,
                offcutsDiscarded: 0,
                deskewSkipped: 0,
                cropSkipped: 0,
                excludedPages: 0,
                blankPagesSkipped: 0,
                warnings: [],
            },
            partial: false,
            progress: progress(1, 1),
            updatedAtMs: Date.now(),
        };
        listener(completed);
        await vi.waitFor(() => expect(openGeneratedPdf).toHaveBeenCalledOnce());

        // While the output document is still being claimed, the run must stay
        // observable as active so workspace detection cannot restart against
        // the source document mid-handoff.
        expect(coordinator.isScanCleanupRunning.value).toBe(true);
        expect(coordinator.scanCleanupRun.activeJobId).toBe('job-open-gate');
        expect(toastAdd).not.toHaveBeenCalled();

        listener(completed);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(openGeneratedPdf).toHaveBeenCalledOnce();

        openGate.resolve(true);
        await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({color: 'success'})));
        expect(coordinator.isScanCleanupRunning.value).toBe(false);
        expect(coordinator.scanCleanupRun.activeJobId).toBeNull();
        cleanup();
    });

    it('contains generated-document open failures and reports them', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        capability.value = {
            preview: vi.fn(),
            previewRaw: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => ({
                started: true as const,
                jobId: 'job-open-failure',
                outputPdfPath: '/managed/job-open-failure.pdf',
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
                return () => undefined;
            }),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const openGeneratedPdf = vi.fn(async () => {
            throw new Error('Invalid or non-existent file');
        });
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf,
            saveActiveDocumentAs: vi.fn(),
            getOpenPdfPaths: () => [],
            t: ((key: string) => key) as never,
            toast: {add: toastAdd},
        });
        await coordinator.startScanCleanup({
            ...ownerContext,
            sourcePdfPath: '/source/book.pdf',
            options: expect.anything() as never,
        });
        listener({
            jobId: 'job-open-failure',
            status: 'completed',
            outputPdfPath: '/managed/missing.pdf',
            summary: {
                inputPages: 1,
                outputPages: 1,
                spreadsSplit: 0,
                offcutsDiscarded: 0,
                deskewSkipped: 0,
                cropSkipped: 0,
                excludedPages: 0,
                blankPagesSkipped: 0,
                warnings: [],
            },
            partial: false,
            progress: progress(1, 1),
            updatedAtMs: Date.now(),
        });

        await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'scanCleanup.openResultFailed',
        })));
        expect(openGeneratedPdf).toHaveBeenCalledWith('/managed/missing.pdf');
        cleanup();
    });

    it('does not restore a stale active id when a terminal event beats start resolution', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        const completed: TScanCleanupJobState = {
            jobId: 'job-instant',
            status: 'completed',
            outputPdfPath: '/managed/instant.pdf',
            summary: {
                inputPages: 1,
                outputPages: 1,
                spreadsSplit: 0,
                offcutsDiscarded: 0,
                deskewSkipped: 0,
                cropSkipped: 0,
                excludedPages: 0,
                blankPagesSkipped: 0,
                warnings: [],
            },
            partial: false,
            progress: progress(1, 1),
            updatedAtMs: Date.now(),
        };
        const subscribeJob = vi.fn(async () => completed);
        capability.value = {
            preview: vi.fn(),
            previewRaw: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => {
                listener(completed);
                return {
                    started: true as const,
                    jobId: completed.jobId,
                    outputPdfPath: completed.outputPdfPath,
                };
            }),
            cancel: vi.fn(async () => true),
            getJobState: vi.fn(async () => null),
            subscribeJob,
            reconnectJob: vi.fn(async () => null),
            pruneGeneratedOutputs: vi.fn(async () => 0),
            onJobState: vi.fn(callback => {
                listener = callback;
                return () => undefined;
            }),
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const openGeneratedPdf = vi.fn(async () => true);
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf,
            saveActiveDocumentAs: vi.fn(),
            getOpenPdfPaths: () => [],
            t: ((key: string) => key) as never,
            toast: {add: vi.fn()},
        });

        await coordinator.startScanCleanup({
            ...ownerContext,
            sourcePdfPath: '/source/instant.pdf',
            options: expect.anything() as never,
        });
        await vi.waitFor(() => expect(openGeneratedPdf).toHaveBeenCalledWith('/managed/instant.pdf'));
        expect(coordinator.scanCleanupRun.activeJobId).toBeNull();
        expect(coordinator.scanCleanupRun.jobState).toEqual(completed);
        expect(subscribeJob).not.toHaveBeenCalled();
        cleanup();
    });

    it('retries coordinator installation when the capability appears later', async () => {
        capability.value = null;
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const dependencies = {
            openGeneratedPdf: vi.fn(async () => true),
            saveActiveDocumentAs: vi.fn(),
            getOpenPdfPaths: () => [],
            t: ((key: string) => key) as never,
            toast: {add: vi.fn()},
        };
        const firstCleanup = coordinator.installScanCleanupRunCoordinator(dependencies);
        const onJobState = vi.fn(() => () => undefined);
        capability.value = {
            preview: vi.fn(),
            previewRaw: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(),
            cancel: vi.fn(),
            getJobState: vi.fn(),
            subscribeJob: vi.fn(),
            reconnectJob: vi.fn(),
            pruneGeneratedOutputs: vi.fn(),
            onJobState,
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const secondCleanup = coordinator.installScanCleanupRunCoordinator(dependencies);

        expect(onJobState).toHaveBeenCalledOnce();
        firstCleanup();
        secondCleanup();
    });
});
