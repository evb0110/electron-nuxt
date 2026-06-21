import { EventEmitter } from 'node:events';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    terminateDetachedChildProcess: vi.fn(async () => {}),
}));

class MockNativeProcess extends EventEmitter {
    readonly stdout = new EventEmitter();

    readonly stderr = new EventEmitter();

    readonly kill = vi.fn();
}

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    createDetachedChildProcessSpawnOptions: (options: unknown) => options,
    terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
}));

describe('runNativeCommand', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    it('rejects an already-aborted signal before spawning', async () => {
        const controller = new AbortController();
        controller.abort();
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');

        await expect(runNativeCommand('/bin/tool', [], {signal: controller.signal}))
            .rejects.toThrow('The operation was aborted');

        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('resolves allowed exit codes and captures bounded stdout/stderr', async () => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', ['--version'], {allowedExitCodes: [
            0,
            3,
        ]});
        proc.stdout.emit('data', Buffer.from('ok'));
        proc.stderr.emit('data', Buffer.from('warn'));
        proc.emit('close', 3, null);

        await expect(resultPromise).resolves.toEqual({
            stdout: 'ok',
            stderr: 'warn',
            exitCode: 3,
        });
    });

    it('formats nonzero exits with truncated output and close signal details', async () => {
        const proc = new MockNativeProcess();
        const log = vi.fn();
        mocks.spawn.mockReturnValue(proc);
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', ['--bad'], {
            commandLabel: 'fixture-tool',
            maxStdoutBytes: 4,
            maxStderrBytes: 4,
            log,
        });
        const rejection: Promise<Error> = resultPromise.then(
            () => {
                throw new Error('Expected command to reject');
            },
            error => error as Error,
        );
        proc.stdout.emit('data', Buffer.from('abcdef'));
        proc.stderr.emit('data', Buffer.from('uvwxyz'));
        proc.emit('close', 2, 'SIGTERM');

        const error = await rejection;
        expect(error.message).toContain('fixture-tool failed with exit code 2');
        expect(error.message).toContain('[stderr truncated to 4 bytes]');
        expect(error.message).toContain('signal=SIGTERM');
        expect(log).toHaveBeenCalledWith('error', expect.stringContaining('cmd=/bin/tool --bad'));
    });

    it('rejects stdout truncation when requested even for successful exits', async () => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {
            commandLabel: 'fixture-tool',
            maxStdoutBytes: 3,
            rejectOnStdoutTruncation: true,
        });
        const rejection: Promise<Error> = resultPromise.then(
            () => {
                throw new Error('Expected command to reject');
            },
            error => error as Error,
        );
        proc.stdout.emit('data', Buffer.from('abcdef'));
        proc.emit('close', 0, null);

        await expect(rejection).resolves.toMatchObject({message: 'fixture-tool stdout exceeded 3 bytes'});
    });

    it('terminates and cleans up listeners on timeout', async () => {
        vi.useFakeTimers();
        const proc = new MockNativeProcess();
        const controller = new AbortController();
        const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
        mocks.spawn.mockReturnValue(proc);
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {
            signal: controller.signal,
            timeoutMs: 10,
        });
        const rejection: Promise<Error> = resultPromise.then(
            () => {
                throw new Error('Expected command to reject');
            },
            error => error as Error,
        );
        await vi.advanceTimersByTimeAsync(10);

        const error = await rejection;
        expect(error.message).toBe('/bin/tool timed out after 10ms');
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 1_000);
        expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
    });
});
