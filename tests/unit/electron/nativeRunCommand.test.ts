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
    readonly stdout = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        unpipe: vi.fn(),
    });

    readonly stderr = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        unpipe: vi.fn(),
    });

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
        vi.unstubAllEnvs();
    });

    it('applies a bounded default timeout when a caller omits one', async () => {
        vi.useFakeTimers();
        vi.stubEnv('EVB_NATIVE_COMMAND_TIMEOUT_MS', '1000');
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', []);
        const rejection = resultPromise.catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(1_000);

        await expect(rejection).resolves.toMatchObject({message: '/bin/tool timed out after 1000ms'});
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 1_000);
    });

    it('rejects an already-aborted signal before spawning', async () => {
        const controller = new AbortController();
        controller.abort();
        const { runNativeCommand } = await import('@electron/native-tools/runNativeCommand');

        await expect(runNativeCommand('/bin/tool', [], {signal: controller.signal}))
            .rejects.toThrow(/(?:This|The) operation was aborted/u);

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

    it.each([
        [
            'stdout' as const,
            'onStdout' as const,
        ],
        [
            'stderr' as const,
            'onStderr' as const,
        ],
    ])('contains throwing %s callbacks and terminates the helper', async (stream, callbackName) => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');
        const resultPromise = runNativeCommand('/bin/tool', [], {[callbackName]: () => {
            throw new Error('callback exploded');
        }});

        expect(() => proc[stream].emit('data', Buffer.from('progress'))).not.toThrow();

        await expect(resultPromise).rejects.toThrow(`${stream} handler failed: callback exploded`);
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 1_000);
    });

    it('rejects a callback failure raised while flushing the decoder on close', async () => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');
        const resultPromise = runNativeCommand('/bin/tool', [], {onStdout: () => {
            throw new Error('flush callback exploded');
        }});

        proc.stdout.emit('data', Buffer.from([0xd0]));
        proc.emit('close', 0, null);

        await expect(resultPromise).rejects.toThrow('stdout handler failed: flush callback exploded');
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 1_000);
    });

    it('decodes UTF-8 incrementally when multibyte characters straddle process chunks', async () => {
        const proc = new MockNativeProcess();
        const onStdout = vi.fn();
        const onStderr = vi.fn();
        mocks.spawn.mockReturnValue(proc);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', [], {
            onStderr,
            onStdout,
        });
        const russian = Buffer.from('Предисловие', 'utf8');
        const splitAt = russian.indexOf(0xd1) + 1;
        const stderr = Buffer.from('ошибка', 'utf8');
        proc.stdout.emit('data', russian.subarray(0, splitAt));
        proc.stdout.emit('data', russian.subarray(splitAt));
        proc.stderr.emit('data', stderr.subarray(0, 1));
        proc.stderr.emit('data', stderr.subarray(1));
        proc.emit('close', 0, null);

        await expect(resultPromise).resolves.toEqual({
            stdout: 'Предисловие',
            stderr: 'ошибка',
            exitCode: 0,
        });
        expect(onStdout.mock.calls.flat().join('')).toBe('Предисловие');
        expect(onStderr.mock.calls.flat().join('')).toBe('ошибка');
        expect(onStdout.mock.calls.flat().join('')).not.toContain('\ufffd');
        expect(onStderr.mock.calls.flat().join('')).not.toContain('\ufffd');
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

    it('classifies native failures from a structured error code instead of message text', async () => {
        const proc = new MockNativeProcess();
        mocks.spawn.mockReturnValue(proc);
        const {runNativeCommand} = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', []);
        proc.stderr.emit('data', Buffer.from('{"code":"corrupt-xref","message":"localized detail"}\n'));
        proc.emit('close', 2, null);

        await expect(resultPromise).rejects.toMatchObject({
            code: 'corrupt-xref',
            message: 'localized detail',
            name: 'NativeToolError',
        });
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
        expect(proc.stdout.listenerCount('data')).toBe(0);
        expect(proc.stderr.listenerCount('data')).toBe(0);
        expect(proc.listenerCount('close')).toBe(0);
        expect(proc.stdout.destroy).toHaveBeenCalledTimes(1);
        expect(proc.stderr.destroy).toHaveBeenCalledTimes(1);
    });

    it('streams output chunks and cancels named command groups', async () => {
        const proc = new MockNativeProcess();
        const onStdout = vi.fn();
        const onStderr = vi.fn();
        mocks.spawn.mockReturnValue(proc);
        const {
            cancelNativeCommandGroup,
            runNativeCommand,
        } = await import('@electron/native-tools/runNativeCommand');

        const resultPromise = runNativeCommand('/bin/tool', ['--watch'], {
            cancelGroup: 'job-1',
            onStderr,
            onStdout,
        });
        const rejection: Promise<Error> = resultPromise.then(
            () => {
                throw new Error('Expected command to reject');
            },
            error => error as Error,
        );

        proc.stdout.emit('data', Buffer.from('progress'));
        proc.stderr.emit('data', Buffer.from('warning'));
        expect(cancelNativeCommandGroup('job-1')).toBe(true);

        const error = await rejection;
        expect(error.message).toBe('The operation was aborted');
        expect(onStdout).toHaveBeenCalledWith('progress');
        expect(onStderr).toHaveBeenCalledWith('warning');
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(proc, 1_000);
        expect(cancelNativeCommandGroup('job-1')).toBe(false);
    });
});
