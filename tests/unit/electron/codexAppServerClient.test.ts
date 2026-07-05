import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    createDetachedChildProcessSpawnOptions: vi.fn((options: Record<string, unknown>) => ({
        ...options,
        detached: true,
    })),
    terminateDetachedChildProcess: vi.fn(),
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

interface IFakeStdin extends EventEmitter {write: ReturnType<typeof vi.fn>;}

class FakeCodexAppServerProcess extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly stdin = new EventEmitter() as IFakeStdin;

    readonly kill = vi.fn(() => {
        this.emit('close', 0);
        return true;
    });

    constructor(write: (line: string, callback?: (error?: Error | null) => void) => boolean) {
        super();
        this.stdin.write = vi.fn(write);
    }
}

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('electron', () => ({app: {getVersion: () => '0.0.0-test'}}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    createDetachedChildProcessSpawnOptions: (...args: [Record<string, unknown>]) =>
        mocks.createDetachedChildProcessSpawnOptions(...args),
    terminateDetachedChildProcess: (...args: unknown[]) => mocks.terminateDetachedChildProcess(...args),
}));

async function createClient(process: FakeCodexAppServerProcess) {
    mocks.spawn.mockReturnValue(process);
    const { CodexAppServerClient } = await import('@electron/features/agent/codexAppServerClient');
    const onNotification = vi.fn();
    const onExit = vi.fn();
    const client = new CodexAppServerClient(
        '/usr/bin/codex',
        {},
        '/tmp',
        onNotification,
        onExit,
    );
    return {
        client,
        onExit,
    };
}

describe('CodexAppServerClient stdin handling', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        delete process.env.EVB_CODEX_APP_SERVER_MAX_STDERR_BYTES;
        mocks.createDetachedChildProcessSpawnOptions.mockImplementation((options: Record<string, unknown>) => ({
            ...options,
            detached: true,
        }));
        mocks.terminateDetachedChildProcess.mockImplementation(async (process: FakeCodexAppServerProcess) => {
            process.emit('close', 0);
        });
    });

    afterEach(async () => {
        vi.useRealTimers();
        const { resetMainOperationLifecycleForTests } = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        resetMainOperationLifecycleForTests();
    });

    it('fails pending requests when the app-server stdin stream errors', async () => {
        const process = new FakeCodexAppServerProcess((_line, callback) => {
            callback?.();
            return true;
        });
        const {
            client,
            onExit,
        } = await createClient(process);

        const request = client.request('thread/start', {});
        process.stdin.emit('error', new Error('EPIPE'));

        await expect(request).rejects.toThrow('Codex app-server stdin failed: EPIPE');
        expect(onExit).toHaveBeenCalledWith('Codex app-server stdin failed: EPIPE');
    });

    it.each([
        ['notify' as const],
        ['respond' as const],
    ])('handles %s write callback failures without throwing', async (method) => {
        const process = new FakeCodexAppServerProcess((_line, callback) => {
            callback?.(new Error('EPIPE'));
            return false;
        });
        const {
            client,
            onExit,
        } = await createClient(process);

        if (method === 'notify') {
            expect(() => client.notify('initialized')).not.toThrow();
        } else {
            expect(() => client.respond(1, null)).not.toThrow();
        }

        expect(onExit).toHaveBeenCalledWith(expect.stringContaining('EPIPE'));
    });

    it('rejects request timeouts with a typed timeout error', async () => {
        vi.useFakeTimers();
        const process = new FakeCodexAppServerProcess((_line, callback) => {
            callback?.();
            return true;
        });
        const { client } = await createClient(process);
        const {
            CodexAppServerRequestTimeoutError,
            isCodexAppServerRequestTimeoutError,
        } = await import('@electron/features/agent/codexAppServerClient');

        const request = client.request('turn/start', {}, 25).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(25);
        const caughtError = await request;

        expect(caughtError).toBeInstanceOf(CodexAppServerRequestTimeoutError);
        expect(isCodexAppServerRequestTimeoutError(caughtError)).toBe(true);
        expect(caughtError).toMatchObject({
            method: 'turn/start',
            timeoutMs: 25,
            message: 'turn/start timed out after 25ms.',
        });
    });

    it('reports a bounded stderr tail when the app-server exits after noisy output', async () => {
        process.env.EVB_CODEX_APP_SERVER_MAX_STDERR_BYTES = '1024';
        const fakeProcess = new FakeCodexAppServerProcess((_line, callback) => {
            callback?.();
            return true;
        });
        const { onExit } = await createClient(fakeProcess);

        fakeProcess.stderr.write(`${'old'.repeat(700)}\nrecent-tail\n`);
        fakeProcess.emit('close', 7);

        expect(onExit).toHaveBeenCalledOnce();
        const message = onExit.mock.calls[0]?.[0] as string;
        expect(message).toContain('with code 7');
        expect(message).toContain('[stderr truncated to 1024 bytes]');
        expect(message).toContain('recent-tail');
        expect(message.length).toBeLessThan(1400);
    });

    it('awaits detached process-tree termination during shutdown', async () => {
        const fakeProcess = new FakeCodexAppServerProcess((_line, callback) => {
            callback?.();
            return true;
        });
        const { client } = await createClient(fakeProcess);
        const { snapshotMainOperations } = await import('@electron/operation-lifecycle/mainOperationLifecycle');

        expect(snapshotMainOperations()).toEqual([expect.objectContaining({kind: 'resource-cleanup'})]);

        await client.shutdown();

        expect(mocks.createDetachedChildProcessSpawnOptions).toHaveBeenCalledWith(expect.objectContaining({
            cwd: '/tmp',
            windowsHide: true,
        }));
        expect(mocks.spawn.mock.calls[0]?.[2]).toMatchObject({detached: true});
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(fakeProcess, 1_000);
        expect(snapshotMainOperations()).toEqual([]);
    });
});
