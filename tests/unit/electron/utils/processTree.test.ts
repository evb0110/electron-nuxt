import { EventEmitter } from 'node:events';
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

describe('terminateProcessTree (win32 taskkill)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('bounds stuck taskkill helper processes', async () => {
        vi.useFakeTimers();
        const pid = makeTestPid(5151);
        const helpers: Array<EventEmitter & {kill: ReturnType<typeof vi.fn>}> = [];
        const spawnSpy = vi.spyOn(processTreeRuntime, 'spawn').mockImplementation((command, args) => {
            const child = new EventEmitter() as EventEmitter & {kill: ReturnType<typeof vi.fn>};
            child.kill = vi.fn();
            helpers.push(child);
            expect(command).toBe('taskkill');
            expect(args).toEqual(expect.arrayContaining([
                '/PID',
                String(pid),
                '/T',
            ]));
            return child as never;
        });
        vi.spyOn(processTreeRuntime, 'kill').mockImplementation(((targetPid, signal?: NodeJS.Signals | 0) => {
            if (targetPid === pid && signal === 0) {
                if (helpers.filter(helper => helper.kill.mock.calls.length > 0).length >= 2) {
                    throw new Error('ESRCH');
                }
                return true;
            }
            return true;
        }) as typeof processTreeRuntime.kill);

        const terminatePromise = terminateProcessTree(pid, {
            graceMs: 0,
            platform: 'win32',
            taskkillTimeoutMs: 50,
        });

        await vi.advanceTimersByTimeAsync(50);
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(50);
        await terminatePromise;

        expect(spawnSpy).toHaveBeenCalledTimes(2);
        expect(spawnSpy.mock.calls[0]?.[1]).not.toContain('/F');
        expect(spawnSpy.mock.calls[1]?.[1]).toContain('/F');
        expect(helpers[0]?.kill).toHaveBeenCalledTimes(1);
        expect(helpers[1]?.kill).toHaveBeenCalledTimes(1);
    });
});
