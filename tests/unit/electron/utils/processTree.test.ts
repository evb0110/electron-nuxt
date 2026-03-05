import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { terminateProcessTree } from '@electron/utils/process-tree';

vi.mock('es-toolkit/promise', () => ({delay: async () => {}}));

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('terminateProcessTree (posix)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('sends SIGTERM and SIGKILL to process group when process stays alive', async () => {
        const killCalls: Array<{
            pid: number;
            signal: NodeJS.Signals | 0 | undefined;
        }> = [];
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
            killCalls.push({
                pid,
                signal,
            });

            if (signal === 0) {
                return true;
            }
            return true;
        }) as typeof process.kill);

        await terminateProcessTree(1234, {
            graceMs: 0,
            preferProcessGroup: true,
        });

        expect(killSpy).toHaveBeenCalled();
        expect(killCalls.some(call => call.pid === -1234 && call.signal === 'SIGTERM')).toBe(true);
        expect(killCalls.some(call => call.pid === -1234 && call.signal === 'SIGKILL')).toBe(true);
    });

    it('does not send SIGKILL when process exits after SIGTERM', async () => {
        let alive = true;
        const killCalls: Array<{
            pid: number;
            signal: NodeJS.Signals | 0 | undefined;
        }> = [];
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
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
        }) as typeof process.kill);

        await terminateProcessTree(4242, {
            graceMs: 10,
            preferProcessGroup: false,
        });

        expect(killCalls.some(call => call.pid === 4242 && call.signal === 'SIGTERM')).toBe(true);
        expect(killCalls.some(call => call.signal === 'SIGKILL')).toBe(false);
    });
});
