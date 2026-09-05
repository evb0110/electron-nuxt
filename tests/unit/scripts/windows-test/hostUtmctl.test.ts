import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    DEFAULT_UTMCTL_PATH,
    UtmctlTransportError,
    classifyUtmctlTransportFailure,
    createUtmctlClient,
    detectsAutomationConsentFailure,
    parseUtmctlListOutput,
} from '@scripts/windows-test/host/utmctlClient';
import type {
    ICommandResult,
    ICommandRunOptions,
    ICommandRunner,
} from '@scripts/windows-test/host/utmctlClient';
import { createUtmctlGuestChannel } from '@scripts/windows-test/host/guestChannel';

const TEST_VM_ID = '11111111-2222-4333-8444-555555555555';

interface IRecordedCommand {
    command: string;
    args: string[];
    options: ICommandRunOptions;
}

function fakeRunner(results: ICommandResult[]) {
    const calls: IRecordedCommand[] = [];
    const runner: ICommandRunner = {run: (command, args, options) => {
        calls.push({
            command,
            args,
            options,
        });
        const next = results.shift();
        return Promise.resolve(next ?? {
            exitCode: 0,
            stdout: '',
            stderr: '',
            timedOut: false,
            signal: null,
        });
    }};
    return {
        calls,
        runner,
    };
}

function result(overrides: Partial<ICommandResult> = {}): ICommandResult {
    return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        signal: null,
        ...overrides,
    };
}

describe('utmctl list parsing', () => {
    it('reads UUID, status and a display name that contains spaces', () => {
        const entries = parseUtmctlListOutput([
            'UUID                                 Status   Name',
            `${TEST_VM_ID} stopped  Windows 11 Golden Image`,
            '22222222-3333-4444-8555-666666666666 started  personal-vm',
            '',
        ].join('\n'));

        expect(entries).toEqual([
            {
                uuid: TEST_VM_ID,
                status: 'stopped',
                name: 'Windows 11 Golden Image',
            },
            {
                uuid: '22222222-3333-4444-8555-666666666666',
                status: 'started',
                name: 'personal-vm',
            },
        ]);
    });

    it('skips the header and any line that does not start with a UUID', () => {
        expect(parseUtmctlListOutput('UUID Status Name\nnot-a-uuid stopped thing\n')).toEqual([]);
    });
});

describe('utmctl transport failure classification', () => {
    it('detects the missing Automation consent OSStatus in either stream', () => {
        expect(detectsAutomationConsentFailure('Error Domain=NSOSStatusErrorDomain Code=-1743')).toBe(true);
        expect(detectsAutomationConsentFailure('Not authorized to send Apple events to UTM.')).toBe(true);
        expect(detectsAutomationConsentFailure('errAEEventNotPermitted')).toBe(true);
        expect(detectsAutomationConsentFailure('command not found')).toBe(false);
    });

    it('classifies consent, timeout and plain transport failures apart', () => {
        expect(classifyUtmctlTransportFailure(result({
            exitCode: 1,
            stderr: 'OSStatus error -1743',
        }))).toBe('automation-consent-missing');
        expect(classifyUtmctlTransportFailure(result({
            exitCode: null,
            timedOut: true,
        }))).toBe('timeout');
        expect(classifyUtmctlTransportFailure(result({
            exitCode: 2,
            stderr: 'no such virtual machine',
        }))).toBe('transport-failed');
        expect(classifyUtmctlTransportFailure(result())).toBeNull();
    });

    it('explains the consent failure instead of echoing the SSH message', async () => {
        const {runner} = fakeRunner([result({
            exitCode: 1,
            stderr: 'utmctl: Failed to connect. Are you running over SSH? OSStatus -1743',
        })]);
        const client = createUtmctlClient({runner});

        const error = await client.list().catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(UtmctlTransportError);
        expect((error as UtmctlTransportError).kind).toBe('automation-consent-missing');
        expect((error as UtmctlTransportError).message).toContain('Automation');
        expect((error as UtmctlTransportError).message).toContain('System Settings');
    });
});

describe('utmctl client commands', () => {
    it('spells stop, clone and delete with the qualified UTM flags', async () => {
        const {
            calls,
            runner,
        } = fakeRunner([]);
        const client = createUtmctlClient({runner});

        await client.stop(TEST_VM_ID, 'request');
        await client.stop(TEST_VM_ID, 'force');
        await client.clone(TEST_VM_ID, 'evb-win-test-clone');
        await client.deleteVm(TEST_VM_ID);

        expect(calls.map(call => call.args)).toEqual([
            [
                'stop',
                '--request',
                TEST_VM_ID,
            ],
            [
                'stop',
                '--force',
                TEST_VM_ID,
            ],
            [
                'clone',
                TEST_VM_ID,
                '--name',
                'evb-win-test-clone',
            ],
            [
                'delete',
                TEST_VM_ID,
            ],
        ]);
        expect(calls[0]?.command).toBe(DEFAULT_UTMCTL_PATH);
    });

    it('supervises exec with an explicit timeout and never reports success itself', async () => {
        const {
            calls,
            runner,
        } = fakeRunner([result({
            exitCode: 0,
            stdout: 'ok',
        })]);
        const client = createUtmctlClient({runner});

        const outcome = await client.exec(TEST_VM_ID, [
            'powershell.exe',
            '-Command',
            'exit 0',
        ], {timeoutMs: 1_234});

        expect(calls[0]?.options.timeoutMs).toBe(1_234);
        expect(calls[0]?.args).toEqual([
            'exec',
            TEST_VM_ID,
            '--cmd',
            'powershell.exe',
            '-Command',
            'exit 0',
        ]);
        expect(outcome).toMatchObject({
            exitCode: 0,
            stdout: 'ok',
            transportFailure: null,
        });
        expect(outcome).not.toHaveProperty('ok');
    });

    it('reports a killed exec as a timeout rather than a guest failure', async () => {
        const {runner} = fakeRunner([result({
            exitCode: null,
            timedOut: true,
            signal: 'SIGKILL',
        })]);
        const client = createUtmctlClient({runner});

        expect(await client.exec(TEST_VM_ID, ['powershell.exe'], {timeoutMs: 10})).toMatchObject({
            timedOut: true,
            transportFailure: 'timeout',
        });
    });

    it('streams file pull straight to a host file so binary payloads survive', async () => {
        const {
            calls,
            runner,
        } = fakeRunner([]);
        const client = createUtmctlClient({runner});

        await client.pushFile(TEST_VM_ID, 'C:\\EVBViewerTests\\inbox\\job.json', '{}');
        await client.pullFile(TEST_VM_ID, 'C:\\EVBViewerTests\\outbox\\result.json', '/tmp/result.json');

        expect(calls[0]?.args).toEqual([
            'file',
            'push',
            TEST_VM_ID,
            'C:\\EVBViewerTests\\inbox\\job.json',
        ]);
        expect(calls[0]?.options.input).toBe('{}');
        expect(calls[1]?.options.stdoutFilePath).toBe('/tmp/result.json');
    });

    it('creates run-scoped guest directories with the path supplied as stdin data', async () => {
        const {
            calls,
            runner,
        } = fakeRunner([]);
        const client = createUtmctlClient({runner});
        const guest = createUtmctlGuestChannel({
            client,
            temporaryFilePath: () => '/tmp/unused-guest-read',
        });

        await guest.ensureDirectory(
            TEST_VM_ID,
            'C:\\EVBViewerTests\\staging\\run-01\\fixtures',
            1_234,
        );

        expect(calls[0]?.args).toContain('--input');
        expect(calls[0]?.args.at(-1)).toContain('New-Item -ItemType Directory -LiteralPath $path -Force');
        expect(calls[0]?.options.input).toBe('C:\\EVBViewerTests\\staging\\run-01\\fixtures\n');
        expect(calls[0]?.options.timeoutMs).toBe(1_234);
    });
});
