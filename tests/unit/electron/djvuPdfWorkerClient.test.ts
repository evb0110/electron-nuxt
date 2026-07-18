import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({ startStreamingWorkerTask: vi.fn() }));

vi.mock('@electron/utils/workerTask', () => ({
    resolveUnpackedWorkerPath: (_baseDir: string, workerFileName: string) => workerFileName,
    startStreamingWorkerTask: mocks.startStreamingWorkerTask,
}));

vi.mock('@electron-worker-bundles/electronWorkerBundles.js', () => ({ WORKER_BUNDLES_BY_ID: { 'djvu-pdf': { fileName: 'djvu-pdf.worker.js' } } }));

describe('DjVu PDF worker client', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.startStreamingWorkerTask.mockReturnValue({
            worker: {
                postMessage: vi.fn(),
                terminate: vi.fn(),
            },
            promise: Promise.resolve(undefined),
        });
    });

    it('uses the worker cancel protocol when a task signal aborts', async () => {
        const controller = new AbortController();
        const { createDjvuPdfBookmarkTask } = await import('@electron/features/djvu/main/pdfWorkerClient');

        createDjvuPdfBookmarkTask('/tmp/input.pdf', '/tmp/output.pdf', [], {signal: controller.signal});

        expect(mocks.startStreamingWorkerTask).toHaveBeenCalledWith(expect.objectContaining({
            createCancelMessage: expect.any(Function),
            resourceLimits: {
                maxOldGenerationSizeMb: 256,
                maxYoungGenerationSizeMb: 64,
                stackSizeMb: 4,
            },
            signal: controller.signal,
        }));
        const options = mocks.startStreamingWorkerTask.mock.calls[0]?.[0];
        expect(options.createCancelMessage('abort')).toEqual({ type: 'cancel' });
    });

    it('passes estimate task signals into the worker cancel protocol', async () => {
        const controller = new AbortController();
        const { createDjvuPdfEstimateTask } = await import('@electron/features/djvu/main/pdfWorkerClient');

        createDjvuPdfEstimateTask('/tmp/page.ppm', 300, {signal: controller.signal});

        expect(mocks.startStreamingWorkerTask).toHaveBeenCalledWith(expect.objectContaining({
            createCancelMessage: expect.any(Function),
            signal: controller.signal,
        }));
    });
});
