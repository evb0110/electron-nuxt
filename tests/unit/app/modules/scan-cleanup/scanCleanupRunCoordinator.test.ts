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
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
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
            onDetectionJobState: vi.fn(() => () => undefined),
        };
        const openGeneratedPdf = vi.fn(async () => true);
        const runOcrOnActiveDocument = vi.fn(async () => true);
        const saveActiveDocumentAs = vi.fn(async () => true);
        const openScanCleanupForDocument = vi.fn(async () => true);
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf,
            runOcrOnActiveDocument,
            saveActiveDocumentAs,
            openScanCleanupForDocument,
            getOpenPdfPaths: () => ['/managed/already-open.pdf'],
            t: ((key: string) => key) as never,
            toast: {add: toastAdd},
        });

        await coordinator.startScanCleanup({
            sourcePdfPath: '/source/book.pdf',
            options: {
                layoutMode: 'auto',
                outputMode: 'bw',
                readingOrder: 'ltr',
                thickness: 0,
                crop: true,
                matchPageSize: true,
                pageAlignment: 'top-center',
                marginsMm: 5,
                despeckle: true,
                skipBlankPages: false,
                straightenCurvedLines: false,
                pageOverrides: {},
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
                excludedPages: 0,
                blankPagesSkipped: 0,
                warnings: [],
            },
            runOcrAfterCleanup: false,
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
            sourcePdfPath: '/source/book.pdf',
            options: expect.anything() as never,
        });
        coordinator.scanCleanupRun.workspaceOpen = false;
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
        expect(openScanCleanupForDocument).toHaveBeenCalledWith('/source/book.pdf');

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
        expect(runOcrOnActiveDocument).not.toHaveBeenCalled();
        cleanup();
    });

    it('maps live owner progress to completed source-page ticks only for that workspace', async () => {
        const {resolveScanCleanupProcessedPages} = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const runningState: TScanCleanupJobState = {
            jobId: 'job-progress',
            status: 'running',
            progress: progress(3, 6),
            updatedAtMs: Date.now(),
        };

        expect([...resolveScanCleanupProcessedPages(
            runningState,
            '/source/book.pdf',
            '/source/book.pdf',
            6,
        )]).toEqual([
            1,
            2,
            3,
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

    it('starts OCR only after the cleaned document opens and reports the combined result', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        capability.value = {
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => ({
                started: true,
                jobId: 'job-ocr',
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
        const order: string[] = [];
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf: vi.fn(async () => {
                order.push('open');
                return true;
            }),
            runOcrOnActiveDocument: vi.fn(async () => {
                order.push('ocr');
                return true;
            }),
            saveActiveDocumentAs: vi.fn(),
            getOpenPdfPaths: () => [],
            t: ((key: string) => key) as never,
            toast: {add: toastAdd},
        });
        await coordinator.startScanCleanup({
            sourcePdfPath: '/source/book.pdf',
            options: expect.anything() as never,
            runOcrAfterCleanup: true,
        });
        listener({
            jobId: 'job-ocr',
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
            runOcrAfterCleanup: true,
            progress: progress(1, 1),
            updatedAtMs: Date.now(),
        });
        await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({title: 'scanCleanup.completedAndOcrTitle'})));
        expect(order).toEqual([
            'open',
            'ocr',
        ]);
        cleanup();
    });

    it('contains generated-document open failures and reports them without starting OCR', async () => {
        let listener: (state: TScanCleanupJobState) => void = () => undefined;
        capability.value = {
            preview: vi.fn(),
            cancelPreview: vi.fn(),
            detectAll: vi.fn(),
            cancelDetection: vi.fn(),
            getDetectionJobState: vi.fn(),
            subscribeDetectionJob: vi.fn(),
            start: vi.fn(async () => ({
                started: true,
                jobId: 'job-open-failure',
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
        const runOcrOnActiveDocument = vi.fn(async () => true);
        const toastAdd = vi.fn();
        const coordinator = await import('@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator');
        const cleanup = coordinator.installScanCleanupRunCoordinator({
            openGeneratedPdf,
            runOcrOnActiveDocument,
            saveActiveDocumentAs: vi.fn(),
            getOpenPdfPaths: () => [],
            t: ((key: string) => key) as never,
            toast: {add: toastAdd},
        });
        await coordinator.startScanCleanup({
            sourcePdfPath: '/source/book.pdf',
            options: expect.anything() as never,
            runOcrAfterCleanup: true,
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
            runOcrAfterCleanup: true,
            progress: progress(1, 1),
            updatedAtMs: Date.now(),
        });

        await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'scanCleanup.openResultFailed',
        })));
        expect(openGeneratedPdf).toHaveBeenCalledWith('/managed/missing.pdf');
        expect(runOcrOnActiveDocument).not.toHaveBeenCalled();
        cleanup();
    });
});
