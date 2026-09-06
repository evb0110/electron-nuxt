import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { FakeAssistantAppServerProcess } from '@tests/unit/electron/helpers/fakeAssistantAppServerProcess';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    terminateDetachedChildProcess: vi.fn(),
}));

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('electron', () => ({app: {getPath: () => '/tmp/evb-codex-test'}}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    createDetachedChildProcessSpawnOptions: (options: Record<string, unknown>) => ({
        ...options,
        detached: true,
    }),
    terminateDetachedChildProcess: (...args: unknown[]) => mocks.terminateDetachedChildProcess(...args),
}));

describe('Codex CLI timeout cleanup', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetModules();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not settle a timeout until the detached process tree is terminated', async () => {
        const process = new FakeAssistantAppServerProcess(() => true);
        let finishTermination!: (terminated: boolean) => void;
        mocks.spawn.mockReturnValue(process);
        mocks.terminateDetachedChildProcess.mockReturnValue(new Promise<boolean>(resolve => {
            finishTermination = resolve;
        }));
        const {runCodexCli} = await import('@electron/features/agent/codexCli');
        let settled = false;
        const resultPromise = runCodexCli('/usr/bin/codex', ['--version']).then((result) => {
            settled = true;
            return result;
        });

        await vi.advanceTimersByTimeAsync(15_000);

        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledWith(process, 1_000);
        expect(settled).toBe(false);

        finishTermination(true);
        await expect(resultPromise).resolves.toMatchObject({
            ok: false,
            stderr: 'Command timed out.',
        });
    });

    it('requests piped output from the spawned process', async () => {
        const process = new FakeAssistantAppServerProcess(() => true);
        mocks.spawn.mockReturnValue(process);
        const {runCodexCli} = await import('@electron/features/agent/codexCli');

        const resultPromise = runCodexCli('/usr/bin/codex', ['--version']);
        process.emit('close', 1);
        await expect(resultPromise).resolves.toMatchObject({
            ok: false,
            exitCode: 1,
        });
        expect(mocks.spawn).toHaveBeenCalledWith(
            '/usr/bin/codex',
            ['--version'],
            expect.objectContaining({stdio: [
                'pipe',
                'pipe',
                'pipe',
            ]}),
        );
    });

    it('reports when timeout cleanup cannot confirm process-tree termination', async () => {
        const process = new FakeAssistantAppServerProcess(() => true);
        mocks.spawn.mockReturnValue(process);
        mocks.terminateDetachedChildProcess.mockResolvedValue(false);
        const {runCodexCli} = await import('@electron/features/agent/codexCli');
        const resultPromise = runCodexCli('/usr/bin/codex', ['--version']);

        await vi.advanceTimersByTimeAsync(15_000);

        await expect(resultPromise).resolves.toMatchObject({
            ok: false,
            stderr: 'Command timed out and its process tree did not terminate.',
        });
    });
});
