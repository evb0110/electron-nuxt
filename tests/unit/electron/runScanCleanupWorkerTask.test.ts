import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({startStreamingWorkerTask: vi.fn()}));

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
});
