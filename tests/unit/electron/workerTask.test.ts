import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    existsSync: vi.fn(() => true),
    workerCtor: vi.fn(),
}));

vi.mock('fs', () => ({existsSync: mocks.existsSync}));
vi.mock('worker_threads', () => ({Worker: class {
    constructor(workerPath: string, options: unknown) {
        mocks.workerCtor(workerPath, options);
        throw new Error('constructor failed');
    }

    terminate() {
        return Promise.resolve(0);
    }
}}));

describe('workerTask', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.existsSync.mockReturnValue(true);
    });

    it('normalizes streaming worker constructor errors as startup errors', async () => {
        const { startStreamingWorkerTask } = await import('@electron/utils/workerTask');

        expect(() => startStreamingWorkerTask({
            workerPath: '/tmp/worker.js',
            workerData: { ok: true },
            invalidPayloadMessage: 'invalid payload',
            createStartupError: message => new Error(`startup: ${message}`),
            createWorkerExitError: code => new Error(`exit: ${code}`),
        })).toThrow('startup: constructor failed');
    });

    it('keeps missing streaming worker paths on the startup error path', async () => {
        mocks.existsSync.mockReturnValue(false);
        const { startStreamingWorkerTask } = await import('@electron/utils/workerTask');

        expect(() => startStreamingWorkerTask({
            workerPath: '/tmp/missing-worker.js',
            workerData: null,
            invalidPayloadMessage: 'invalid payload',
            createStartupError: message => new Error(`startup: ${message}`),
            createWorkerExitError: code => new Error(`exit: ${code}`),
        })).toThrow('startup: Worker unavailable at path: /tmp/missing-worker.js');
        expect(mocks.workerCtor).not.toHaveBeenCalled();
    });
});
