import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isErrnoException } from '@contracts/runtimeGuards';
import { isVmUuid } from '@scripts/windows-test/contracts/windowsTestContracts';

export const DEFAULT_UTMCTL_PATH = '/Applications/UTM.app/Contents/MacOS/utmctl';

// Captured from `utmctl help <subcommand>` of the installed UTM 4.7.5 build 118.
// Keeping them in one injectable record lets a different UTM build be qualified
// without editing call sites.
export const defaultUtmctlCommandSpelling = {
    version: ['version'],
    list: ['list'],
    status: ['status'],
    start: ['start'],
    stopRequest: [
        'stop',
        '--request',
    ],
    stopForce: [
        'stop',
        '--force',
    ],
    clone: ['clone'],
    cloneNameFlag: '--name',
    delete: ['delete'],
    ipAddress: ['ip-address'],
    exec: ['exec'],
    execCommandFlag: '--cmd',
    execInputFlag: '--input',
    filePush: [
        'file',
        'push',
    ],
    filePull: [
        'file',
        'pull',
    ],
} as const;

export type TUtmctlCommandSpelling = typeof defaultUtmctlCommandSpelling;

export interface ICommandResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    signal: NodeJS.Signals | null;
}

export interface ICommandRunOptions {
    timeoutMs: number;
    input?: string | Uint8Array;
    // Streams stdout straight to a file so binary `utmctl file pull` payloads
    // survive without a lossy utf8 decode.
    stdoutFilePath?: string;
}

export interface ICommandRunner {run(command: string, args: string[], options: ICommandRunOptions): Promise<ICommandResult>;}

export function createProcessCommandRunner(): ICommandRunner {
    return {run: async (command, args, options) => new Promise<ICommandResult>((resolve, reject) => {
        const child = spawn(command, args, {stdio: [
            options.input === undefined ? 'ignore' : 'pipe',
            'pipe',
            'pipe',
        ]});
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let timedOut = false;
        let settled = false;

        const stdoutFile = options.stdoutFilePath === undefined
            ? null
            : createWriteStream(options.stdoutFilePath);
        if (stdoutFile === null) {
            child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
        } else {
            child.stdout?.pipe(stdoutFile);
        }
        child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, options.timeoutMs);

        const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve({
                exitCode,
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr: Buffer.concat(stderrChunks).toString('utf8'),
                timedOut,
                signal,
            });
        };

        const fail = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
            }
            stdoutFile?.destroy();
            const cleanup = options.stdoutFilePath === undefined
                ? Promise.resolve()
                : rm(options.stdoutFilePath, {force: true}).catch(() => undefined);
            void cleanup.then(() => reject(error));
        };

        child.on('error', fail);
        // A capture file that cannot be written must not leave the pull
        // looking successful; a stdin write to a child that already exited is
        // reported by the exit code instead.
        stdoutFile?.on('error', fail);
        child.stdin?.on('error', (error) => {
            if (isErrnoException(error) && error.code === 'EPIPE') {
                return;
            }
            fail(error);
        });
        child.on('close', (code, signal) => {
            if (stdoutFile === null) {
                finish(code, signal);
                return;
            }
            stdoutFile.end(() => finish(code, signal));
        });

        if (options.input !== undefined && child.stdin !== null) {
            child.stdin.end(options.input);
        }
    })};
}

export interface IUtmVmListEntry {
    uuid: string;
    status: string;
    name: string;
}

export function parseUtmctlListOutput(stdout: string): IUtmVmListEntry[] {
    const entries: IUtmVmListEntry[] = [];
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            continue;
        }
        const columns = trimmed.split(/\s+/u);
        const uuid = columns[0];
        const status = columns[1];
        if (uuid === undefined || status === undefined || !isVmUuid(uuid)) {
            continue;
        }
        entries.push({
            uuid: uuid.toLowerCase(),
            status: status.toLowerCase(),
            // A UTM display name may contain spaces, so everything after the
            // status column belongs to the name.
            name: columns.slice(2).join(' '),
        });
    }
    return entries;
}

export const utmctlFailureKinds = [
    'automation-consent-missing',
    'timeout',
    'transport-failed',
] as const;

export type TUtmctlFailureKind = typeof utmctlFailureKinds[number];

const AUTOMATION_CONSENT_OSSTATUS = -1743;

export function detectsAutomationConsentFailure(text: string) {
    return text.includes(String(AUTOMATION_CONSENT_OSSTATUS))
        || /not authorized to send apple events/iu.test(text)
        || /errAEEventNotPermitted/u.test(text);
}

// The transport can only report whether utmctl itself reached UTM. A zero exit
// says nothing about guest work (invariant I3), so callers must still validate
// a guest completion record.
export function classifyUtmctlTransportFailure(result: ICommandResult): TUtmctlFailureKind | null {
    const combined = `${result.stdout}\n${result.stderr}`;
    if (detectsAutomationConsentFailure(combined)) {
        return 'automation-consent-missing';
    }
    if (result.timedOut) {
        return 'timeout';
    }
    if (result.exitCode !== 0) {
        return 'transport-failed';
    }
    return null;
}

export class UtmctlTransportError extends Error {
    readonly kind: TUtmctlFailureKind;

    readonly args: string[];

    readonly result: ICommandResult;

    constructor(kind: TUtmctlFailureKind, args: string[], result: ICommandResult) {
        super(UtmctlTransportError.describe(kind, args, result));
        this.name = 'UtmctlTransportError';
        this.kind = kind;
        this.args = args;
        this.result = result;
    }

    private static describe(kind: TUtmctlFailureKind, args: string[], result: ICommandResult) {
        const command = `utmctl ${args.join(' ')}`;
        if (kind === 'automation-consent-missing') {
            return [
                `${command} failed with OSStatus ${AUTOMATION_CONSENT_OSSTATUS}:`,
                'the launcher running this coordinator has no macOS Automation consent for UTM.',
                'Grant it in System Settings > Privacy & Security > Automation for the qualified launcher.',
                'The CLI\'s own message blames SSH and does not identify this cause.',
            ].join(' ');
        }
        if (kind === 'timeout') {
            return `${command} exceeded its supervised timeout and was killed.`;
        }
        return `${command} failed with exit code ${String(result.exitCode)}: ${result.stderr.trim()}`;
    }
}

export interface IUtmctlExecOutcome {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    signal: NodeJS.Signals | null;
    transportFailure: TUtmctlFailureKind | null;
}

export interface IUtmctlClientOptions {
    runner: ICommandRunner;
    utmctlPath?: string;
    spelling?: TUtmctlCommandSpelling;
    defaultTimeoutMs?: number;
}

export interface IUtmctlClient {
    version(): Promise<string>;
    list(): Promise<IUtmVmListEntry[]>;
    status(vmId: string): Promise<string>;
    start(vmId: string): Promise<void>;
    stop(vmId: string, mode: 'request' | 'force'): Promise<void>;
    clone(sourceVmId: string, name: string): Promise<void>;
    deleteVm(vmId: string): Promise<void>;
    ipAddress(vmId: string): Promise<string[]>;
    exec(vmId: string, command: readonly string[], options?: {
        timeoutMs?: number;
        input?: string;
    }): Promise<IUtmctlExecOutcome>;
    pushFile(vmId: string, guestPath: string, contents: Uint8Array | string, options?: {timeoutMs?: number;}): Promise<void>;
    pullFile(vmId: string, guestPath: string, hostPath: string, options?: {timeoutMs?: number;}): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function createUtmctlClient(options: IUtmctlClientOptions): IUtmctlClient {
    const utmctlPath = options.utmctlPath ?? DEFAULT_UTMCTL_PATH;
    const spelling = options.spelling ?? defaultUtmctlCommandSpelling;
    const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    const runChecked = async (args: string[], runOptions: ICommandRunOptions) => {
        const result = await options.runner.run(utmctlPath, args, runOptions);
        const failure = classifyUtmctlTransportFailure(result);
        if (failure !== null) {
            throw new UtmctlTransportError(failure, args, result);
        }
        return result;
    };

    return {
        version: async () => (await runChecked([...spelling.version], {timeoutMs: defaultTimeoutMs})).stdout.trim(),
        list: async () => parseUtmctlListOutput(
            (await runChecked([...spelling.list], {timeoutMs: defaultTimeoutMs})).stdout,
        ),
        status: async (vmId) => (await runChecked([
            ...spelling.status,
            vmId,
        ], {timeoutMs: defaultTimeoutMs})).stdout.trim().toLowerCase(),
        start: async (vmId) => {
            await runChecked([
                ...spelling.start,
                vmId,
            ], {timeoutMs: defaultTimeoutMs});
        },
        stop: async (vmId, mode) => {
            await runChecked([
                ...(mode === 'force' ? spelling.stopForce : spelling.stopRequest),
                vmId,
            ], {timeoutMs: defaultTimeoutMs});
        },
        clone: async (sourceVmId, name) => {
            await runChecked([
                ...spelling.clone,
                sourceVmId,
                spelling.cloneNameFlag,
                name,
            ], {timeoutMs: defaultTimeoutMs});
        },
        deleteVm: async (vmId) => {
            await runChecked([
                ...spelling.delete,
                vmId,
            ], {timeoutMs: defaultTimeoutMs});
        },
        ipAddress: async (vmId) => (await runChecked([
            ...spelling.ipAddress,
            vmId,
        ], {timeoutMs: defaultTimeoutMs})).stdout
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0),
        exec: async (vmId, command, execOptions) => {
            const args = [
                ...spelling.exec,
                vmId,
                ...(execOptions?.input === undefined ? [] : [spelling.execInputFlag]),
                spelling.execCommandFlag,
                ...command,
            ];
            // `utmctl exec` has no timeout of its own, so the supervised runner
            // timeout is the only bound on a hung guest command.
            const runOptions: ICommandRunOptions = execOptions?.input === undefined
                ? {timeoutMs: execOptions?.timeoutMs ?? defaultTimeoutMs}
                : {
                    timeoutMs: execOptions.timeoutMs ?? defaultTimeoutMs,
                    input: execOptions.input,
                };
            const result = await options.runner.run(utmctlPath, args, runOptions);
            return {
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                timedOut: result.timedOut,
                signal: result.signal,
                transportFailure: detectsAutomationConsentFailure(`${result.stdout}\n${result.stderr}`)
                    ? 'automation-consent-missing'
                    : result.timedOut
                        ? 'timeout'
                        : null,
            };
        },
        pushFile: async (vmId, guestPath, contents, pushOptions) => {
            await runChecked([
                ...spelling.filePush,
                vmId,
                guestPath,
            ], {
                timeoutMs: pushOptions?.timeoutMs ?? defaultTimeoutMs,
                input: contents,
            });
        },
        pullFile: async (vmId, guestPath, hostPath, pullOptions) => {
            try {
                await runChecked([
                    ...spelling.filePull,
                    vmId,
                    guestPath,
                ], {
                    timeoutMs: pullOptions?.timeoutMs ?? defaultTimeoutMs,
                    stdoutFilePath: hostPath,
                });
            } catch (error) {
                // A non-zero exit or a timeout leaves a partial capture that a
                // later reader would mistake for the real file.
                await rm(hostPath, {force: true});
                throw error;
            }
        },
    };
}
