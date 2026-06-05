import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    processTreeRuntime,
    terminateProcessTree,
} from '@electron/utils/processTree';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
// terminateProcessTree intentionally refuses to signal the current process.
// Avoid fixed PIDs that can collide with the Vitest worker on CI runners.
const makeTestPid = (pid: number) => (pid === process.pid ? pid + 1 : pid);

describePosix('terminateProcessTree (posix)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('sends SIGTERM and SIGKILL to process group when process stays alive', async () => {
        const pid = makeTestPid(1234);
        const killCalls: Array<{
            pid: number;
            signal: NodeJS.Signals | 0 | undefined;
        }> = [];
        const killSpy = vi.spyOn(processTreeRuntime, 'kill').mockImplementation(((pid, signal?: NodeJS.Signals | 0) => {
            killCalls.push({
                pid,
                signal,
            });

            if (signal === 0) {
                return true;
            }
            return true;
        }) as typeof processTreeRuntime.kill);

        await terminateProcessTree(pid, {
            graceMs: 0,
            preferProcessGroup: true,
        });

        expect(killSpy).toHaveBeenCalled();
        expect(killCalls.some(call => call.pid === -pid && call.signal === 'SIGTERM')).toBe(true);
        expect(killCalls.some(call => call.pid === -pid && call.signal === 'SIGKILL')).toBe(true);
    });

    it('does not send SIGKILL when process exits after SIGTERM', async () => {
        const pid = makeTestPid(4242);
        let alive = true;
        const killCalls: Array<{
            pid: number;
            signal: NodeJS.Signals | 0 | undefined;
        }> = [];
        vi.spyOn(processTreeRuntime, 'kill').mockImplementation(((pid, signal?: NodeJS.Signals | 0) => {
            killCalls.push({
                pid,
                signal,
            });

            if (signal === 0) {
                if (alive) {
                    return true;
                }
                throw new Error('ESRCH');
            }
            if (signal === 'SIGTERM') {
                alive = false;
                return true;
            }
            return true;
        }) as typeof processTreeRuntime.kill);

        await terminateProcessTree(pid, {
            graceMs: 1_000,
            preferProcessGroup: false,
        });

        expect(killCalls.some(call => call.pid === pid && call.signal === 'SIGTERM')).toBe(true);
        expect(killCalls.some(call => call.signal === 'SIGKILL')).toBe(false);
    });
});
