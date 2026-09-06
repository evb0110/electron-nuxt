import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    ICommandResult,
    ICommandRunner,
} from '@scripts/windows-test/host/utmctlClient';
import {createProcessIdentityProbe} from '@scripts/windows-test/host/hostProcessIdentity';
import {
    UTM_APPLICATION_EXECUTABLE_PATH,
    UTM_OSASCRIPT_PATH,
    createUtmAppleEventRunner,
} from '@scripts/windows-test/host/utmProcessGuard';

const UTMCTL_PATH = '/tmp/windows-tests/tools/utmctl-probe/utmctl';

function result(): ICommandResult {
    return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        signal: null,
    };
}

function harness(processes: ReadonlyArray<{
    pid: number;
    startTime: string;
    executable: string;
}>) {
    const calls: Array<{
        command: string;
        args: string[]
    }> = [];
    const runner: ICommandRunner = {run: async (command, args) => {
        calls.push({
            command,
            args,
        });
        return result();
    }};
    const guarded = createUtmAppleEventRunner({
        runner,
        processProbe: {
            isAlive: () => true,
            startTime: () => Promise.resolve(null),
        },
        utmctlPath: UTMCTL_PATH,
        listProcesses: async () => processes,
    });
    return {
        calls,
        guarded,
    };
}

function processIdentity(pid: number, startTime = 'Sat Sep  5 08:49:00 2026') {
    return {
        pid,
        startTime,
        executable: UTM_APPLICATION_EXECUTABLE_PATH,
    };
}

describe('UTM Apple Event process guard', () => {
    it('refuses an absent UTM process before utmctl or clone import dispatch', async () => {
        const {
            calls,
            guarded,
        } = harness([]);

        await expect(guarded.run(UTMCTL_PATH, ['list'], {timeoutMs: 1_000}))
            .rejects.toMatchObject({kind: 'missing'});
        await expect(guarded.run(UTM_OSASCRIPT_PATH, [
            '-e',
            'tell application id "com.utmapp.UTM" to open POSIX file "/tmp/test.utm"',
        ], {timeoutMs: 1_000}))
            .rejects.toMatchObject({kind: 'missing'});

        expect(calls).toEqual([]);
    });

    it('pins PID and start time, then refuses a replacement without dispatching it', async () => {
        let current = processIdentity(1234);
        const calls: Array<{
            command: string;
            args: string[]
        }> = [];
        const guarded = createUtmAppleEventRunner({
            runner: {run: async (command, args) => {
                calls.push({
                    command,
                    args,
                });
                return result();
            }},
            processProbe: {
                isAlive: () => true,
                startTime: () => Promise.resolve(null),
            },
            utmctlPath: UTMCTL_PATH,
            listProcesses: async () => [current],
        });

        await guarded.run(UTMCTL_PATH, ['version'], {timeoutMs: 1_000});
        current = processIdentity(5678, 'Sat Sep  5 08:50:00 2026');
        await expect(guarded.run(UTMCTL_PATH, ['list'], {timeoutMs: 1_000}))
            .rejects.toMatchObject({kind: 'replaced'});

        expect(calls).toHaveLength(1);
    });

    it('allows stable UTM identity and leaves unrelated commands unguarded', async () => {
        const {
            calls,
            guarded,
        } = harness([processIdentity(1234)]);
        const unrelated = harness([]);

        await unrelated.guarded.run('/usr/bin/plutil', [
            '-convert',
            'json',
        ], {timeoutMs: 1_000});
        expect(unrelated.calls).toEqual([{
            command: '/usr/bin/plutil',
            args: [
                '-convert',
                'json',
            ],
        }]);
        await guarded.run(UTMCTL_PATH, ['list'], {timeoutMs: 1_000});
        await guarded.run(UTM_OSASCRIPT_PATH, [
            '-e',
            'return 1',
        ], {timeoutMs: 1_000});
        await guarded.run(UTMCTL_PATH, [
            'status',
            'vm',
        ], {timeoutMs: 1_000});

        expect(calls).toHaveLength(3);
    });

    it('guards every osascript invocation by executable path', async () => {
        const {
            calls,
            guarded,
        } = harness([processIdentity(1234)]);
        await guarded.run(UTM_OSASCRIPT_PATH, [
            '-e',
            'set target to application "not UTM"\ntell target to open',
        ], {timeoutMs: 1_000});
        expect(calls).toHaveLength(1);
    });

    it('gets the exact UTM executable and start time from read-only ps probes', async () => {
        const calls: Array<{
            command: string;
            args: string[]
        }> = [];
        const runner: ICommandRunner = {run: async (command, args) => {
            calls.push({
                command,
                args,
            });
            if (command === '/bin/ps' && args[0] === '-axo') {
                return {
                    ...result(),
                    stdout: [
                        ` 123 ${UTM_APPLICATION_EXECUTABLE_PATH}`,
                        ' 456 /Applications/UTM.app/Contents/XPCServices/QEMUHelper.xpc/Contents/MacOS/QEMUHelper',
                    ].join('\n'),
                };
            }
            if (command === '/bin/ps' && args[0] === '-o') {
                return {
                    ...result(),
                    stdout: 'Sat Sep  5 08:49:00 2026\n',
                };
            }
            return result();
        }};
        const guarded = createUtmAppleEventRunner({
            runner,
            processProbe: createProcessIdentityProbe(runner),
            utmctlPath: UTMCTL_PATH,
        });

        await guarded.run(UTMCTL_PATH, ['list'], {timeoutMs: 1_000});

        expect(calls).toEqual([
            {
                command: '/bin/ps',
                args: [
                    '-axo',
                    'pid=,comm=',
                ],
            },
            {
                command: '/bin/ps',
                args: [
                    '-o',
                    'lstart=',
                    '-p',
                    '123',
                ],
            },
            {
                command: UTMCTL_PATH,
                args: ['list'],
            },
        ]);
    });
});
