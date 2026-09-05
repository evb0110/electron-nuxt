import path from 'node:path';
import type {
    ICommandResult,
    ICommandRunner,
    ICommandRunOptions,
} from '@scripts/windows-test/host/utmctlClient';
import type {IHostProcessIdentityProbe} from '@scripts/windows-test/host/hostProcessIdentity';

export const UTM_APPLICATION_EXECUTABLE_PATH = '/Applications/UTM.app/Contents/MacOS/UTM';
export const UTM_OSASCRIPT_PATH = '/usr/bin/osascript';

const PROCESS_LIST_TIMEOUT_MS = 5_000;

export interface IUtmProcessIdentity {
    pid: number;
    startTime: string;
    executable: string;
}

export type TUtmProcessGuardFailureKind = 'process-scan-failed' | 'missing' | 'multiple' | 'replaced';

export class UtmProcessGuardError extends Error {
    readonly kind: TUtmProcessGuardFailureKind;

    constructor(kind: TUtmProcessGuardFailureKind, message: string) {
        super(message);
        this.name = 'UtmProcessGuardError';
        this.kind = kind;
    }
}

export interface IUtmProcessGuardDependencies {
    runner: ICommandRunner;
    processProbe: IHostProcessIdentityProbe;
    utmctlPath: string;
    listProcesses?(): Promise<readonly IUtmProcessIdentity[]>;
    utmExecutablePath?: string;
    osascriptPath?: string;
}

export interface IUtmAppleEventRunner extends ICommandRunner {assertUtmProcess(): Promise<IUtmProcessIdentity>;}

function parseProcessList(stdout: string, executablePath: string) {
    const expectedExecutable = path.resolve(executablePath);
    return stdout.split('\n').flatMap(line => {
        const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
        if (match === null) {
            return [];
        }
        const pid = Number(match[1]);
        const executable = match[2]?.trim();
        return Number.isInteger(pid) && pid > 0 && executable === expectedExecutable
            ? [{
                pid,
                executable,
            }]
            : [];
    });
}

async function listUtmProcesses(
    runner: ICommandRunner,
    processProbe: IHostProcessIdentityProbe,
    executablePath: string,
): Promise<readonly IUtmProcessIdentity[]> {
    let result: ICommandResult;
    try {
        result = await runner.run('/bin/ps', [
            '-axo',
            'pid=,comm=',
        ], {timeoutMs: PROCESS_LIST_TIMEOUT_MS});
    } catch (error) {
        throw new UtmProcessGuardError(
            'process-scan-failed',
            `Could not inspect the UTM process table: ${error instanceof Error ? error.message : String(error)}. Keep UTM running and retry the Windows lane.`,
        );
    }
    if (result.exitCode !== 0 || result.timedOut) {
        throw new UtmProcessGuardError(
            'process-scan-failed',
            `Could not inspect the UTM process table: ${result.stderr.trim() || 'ps failed'}. Keep UTM running and retry the Windows lane.`,
        );
    }
    const processes = parseProcessList(result.stdout, executablePath);
    const identities: IUtmProcessIdentity[] = [];
    for (const process of processes) {
        let startTime: string | null;
        try {
            startTime = await processProbe.startTime(process.pid);
        } catch (error) {
            throw new UtmProcessGuardError(
                'process-scan-failed',
                `Could not read the start time for UTM pid ${process.pid}: ${error instanceof Error ? error.message : String(error)}. Refusing to send Apple Events; keep UTM running and retry the Windows lane.`,
            );
        }
        if (startTime === null) {
            throw new UtmProcessGuardError(
                'process-scan-failed',
                `Could not read the start time for UTM pid ${process.pid}; refusing to send Apple Events. Keep UTM running and retry the Windows lane.`,
            );
        }
        identities.push({
            pid: process.pid,
            startTime,
            executable: process.executable,
        });
    }
    return identities;
}

function isUtmAppleEventCommand(
    command: string,
    args: readonly string[],
    utmctlPath: string,
    osascriptPath: string,
) {
    const resolvedCommand = path.resolve(command);
    if (resolvedCommand === path.resolve(utmctlPath)) {
        return true;
    }
    if (resolvedCommand !== path.resolve(osascriptPath)) {
        return false;
    }
    // Every osascript invocation through this runner is an UTM Apple Event.
    // Guard ownership from the executable path, not from script text that a
    // caller can spell with aliases or variables.
    return true;
}

function sameProcessIdentity(left: IUtmProcessIdentity, right: IUtmProcessIdentity) {
    return left.pid === right.pid
        && left.startTime === right.startTime
        && left.executable === right.executable;
}

export function createUtmAppleEventRunner(
    dependencies: IUtmProcessGuardDependencies,
): IUtmAppleEventRunner {
    const executablePath = path.resolve(dependencies.utmExecutablePath ?? UTM_APPLICATION_EXECUTABLE_PATH);
    const osascriptPath = dependencies.osascriptPath ?? UTM_OSASCRIPT_PATH;
    const listProcesses = dependencies.listProcesses
        ?? (() => listUtmProcesses(dependencies.runner, dependencies.processProbe, executablePath));
    let pinnedProcess: IUtmProcessIdentity | null = null;

    const assertUtmProcess = async () => {
        const processes = await listProcesses();
        if (processes.length === 0) {
            throw new UtmProcessGuardError(
                'missing',
                `UTM is not running at ${executablePath}; refusing to send Apple Events. Start UTM yourself, wait for its window to appear, and retry the Windows lane.`,
            );
        }
        if (processes.length !== 1) {
            throw new UtmProcessGuardError(
                'multiple',
                `Expected exactly one UTM process at ${executablePath}, found ${processes.length}; refusing to send Apple Events. Close duplicate UTM instances and retry the Windows lane.`,
            );
        }
        const current = processes[0]!;
        if (pinnedProcess === null) {
            pinnedProcess = current;
            return current;
        }
        if (!sameProcessIdentity(pinnedProcess, current)) {
            throw new UtmProcessGuardError(
                'replaced',
                `The UTM process changed from pid ${pinnedProcess.pid} (${pinnedProcess.startTime}) to pid ${current.pid} (${current.startTime}); refusing to send Apple Events after an app restart. Start a fresh Windows test run.`,
            );
        }
        return current;
    };

    return {
        assertUtmProcess,
        run: async (command: string, args: string[], options: ICommandRunOptions) => {
            if (isUtmAppleEventCommand(command, args, dependencies.utmctlPath, osascriptPath)) {
                await assertUtmProcess();
            }
            return dependencies.runner.run(command, args, options);
        },
    };
}
