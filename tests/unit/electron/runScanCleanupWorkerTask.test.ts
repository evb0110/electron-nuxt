import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
    startStreamingWorkerTask: vi.fn(),
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

vi.mock('@electron/utils/workerTask', () => ({
    resolveUnpackedWorkerPath: (_baseDir: string, workerFileName: string) => workerFileName,
    startStreamingWorkerTask: mocks.startStreamingWorkerTask,
}));

vi.mock('@electron-worker-bundles/electronWorkerBundles.js', () => ({WORKER_BUNDLES_BY_ID: {'scan-cleanup': {fileName: 'scan-cleanup-worker.js'}}}));

describe('runScanCleanupWorkerTask', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.startStreamingWorkerTask.mockReturnValue({
            worker: {},
            promise: Promise.resolve({}),
        });
    });

    it('uses progress inactivity rather than wall-clock time to bound long cleanup jobs', async () => {
        const {runScanCleanupWorkerTask} = await import(
            '@electron/features/scan-cleanup/runScanCleanupWorkerTask'
        );

        await runScanCleanupWorkerTask(
            {} as never,
            {} as never,
            {} as never,
            new AbortController().signal,
            vi.fn(),
        );

        const options = mocks.startStreamingWorkerTask.mock.calls[0]?.[0];
        expect(options).toEqual(expect.objectContaining({
            inactivityTimeoutMs: 60 * 60 * 1_000,
            onProgressMessage: expect.any(Function),
        }));
        expect(options).not.toHaveProperty('timeoutMs');
    });

    it('does not report an expected caller cancellation as a worker failure', async () => {
        const controller = new AbortController();
        const cancellation = new Error('Scan cleanup canceled');
        controller.abort(cancellation);
        mocks.startStreamingWorkerTask.mockReturnValue({
            worker: {},
            promise: Promise.reject(cancellation),
        });
        const {runScanCleanupWorkerTask} = await import(
            '@electron/features/scan-cleanup/runScanCleanupWorkerTask'
        );

        await expect(runScanCleanupWorkerTask(
            {} as never,
            {} as never,
            {} as never,
            controller.signal,
            vi.fn(),
        )).rejects.toBe(cancellation);

        expect(mocks.logger.info).toHaveBeenCalledWith('Scan cleanup worker task canceled');
        expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    it('still reports a genuine worker rejection as an error', async () => {
        const failure = new Error('native pipeline failed');
        mocks.startStreamingWorkerTask.mockReturnValue({
            worker: {},
            promise: Promise.reject(failure),
        });
        const {runScanCleanupWorkerTask} = await import(
            '@electron/features/scan-cleanup/runScanCleanupWorkerTask'
        );

        await expect(runScanCleanupWorkerTask(
            {} as never,
            {} as never,
            {} as never,
            new AbortController().signal,
            vi.fn(),
        )).rejects.toBe(failure);

        expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('native pipeline failed'));
        expect(mocks.logger.info).not.toHaveBeenCalled();
    });
});
