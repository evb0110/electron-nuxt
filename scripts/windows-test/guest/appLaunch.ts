import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { forbiddenAcceptanceLaunchFlags } from '@scripts/windows-test/contracts/windowsTestContracts';
import type { TWindowsTestArchitecture } from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    joinGuestPath,
    WINDOWS_GUEST_PATH_SEPARATOR,
} from '@scripts/windows-test/guest/guestPaths';
import {
    sha256Hex,
    type IGuestClock,
    type IGuestFileSystem,
} from '@scripts/windows-test/guest/guestRuntime';

export const windowsLaunchProfiles = [
    'instrumentation',
    'acceptance',
] as const;

export type TWindowsLaunchProfile = typeof windowsLaunchProfiles[number];

export const DEFAULT_INSTALL_RELATIVE_PATH = [
    'Programs',
    'EVB Viewer',
    'EVB Viewer.exe',
] as const;

export const acceptanceForbiddenFlagPrefixes = [
    '--remote-debugging-port',
    '--remote-debugging-pipe',
    '--user-data-dir',
    '--inspect',
    '--inspect-brk',
    '--auto-open-devtools-for-tabs',
    '--enable-logging',
] as const;

export interface ILaunchArgumentValidation {
    allowed: boolean;
    violations: string[];
}

function matchesForbiddenFlag(argument: string, forbiddenFlag: string) {
    if (argument === forbiddenFlag) {
        return true;
    }
    const equalsIndex = forbiddenFlag.indexOf('=');
    if (equalsIndex < 0) {
        return argument.startsWith(`${forbiddenFlag}=`);
    }
    const name = forbiddenFlag.slice(0, equalsIndex);
    const value = forbiddenFlag.slice(equalsIndex + 1);
    return argument.startsWith(`${name}=`)
        && argument.slice(name.length + 1).split(',').includes(value);
}

export function validateLaunchArguments(
    args: readonly string[],
    profile: TWindowsLaunchProfile,
): ILaunchArgumentValidation {
    const violations: string[] = [];
    for (const argument of args) {
        const forbidden = forbiddenAcceptanceLaunchFlags.find(flag => matchesForbiddenFlag(argument, flag));
        if (forbidden !== undefined) {
            violations.push(`${argument} is a forbidden security-policy override (${forbidden})`);
            continue;
        }
        if (profile !== 'acceptance') {
            continue;
        }
        if (argument.startsWith('--disable-') || argument.startsWith('--enable-')) {
            violations.push(`${argument} is not an approved acceptance launch flag`);
            continue;
        }
        const forbiddenPrefix = acceptanceForbiddenFlagPrefixes
            .find(prefix => argument === prefix || argument.startsWith(`${prefix}=`));
        if (forbiddenPrefix !== undefined) {
            violations.push(`${argument} is a debugging or instrumentation flag rejected by acceptance launches`);
        }
    }
    return {
        allowed: violations.length === 0,
        violations,
    };
}

export interface IBuildLaunchArgumentsOptions {
    profile: TWindowsLaunchProfile;
    remoteDebuggingPort?: number;
    userDataDirectory?: string;
    documentPath?: string;
}

export function buildLaunchArguments({
    profile,
    remoteDebuggingPort,
    userDataDirectory,
    documentPath,
}: IBuildLaunchArgumentsOptions) {
    const args: string[] = [];
    if (profile === 'instrumentation') {
        if (remoteDebuggingPort === undefined || userDataDirectory === undefined) {
            throw new Error('The instrumentation profile requires a loopback debugging port and an isolated user data directory');
        }
        args.push(`--remote-debugging-port=${remoteDebuggingPort}`, `--user-data-dir=${userDataDirectory}`);
    }
    if (documentPath !== undefined) {
        if (documentPath.startsWith('-')) {
            throw new Error(`Refusing to launch: document path ${documentPath} would be parsed as a launch switch`);
        }
        args.push(documentPath);
    }
    const validation = validateLaunchArguments(args, profile);
    if (!validation.allowed) {
        throw new Error(`Refusing to launch: ${validation.violations.join('; ')}`);
    }
    return args;
}

export function resolveInstalledExecutablePath(
    env: NodeJS.ProcessEnv = process.env,
    separator: string = WINDOWS_GUEST_PATH_SEPARATOR,
) {
    const override = env.EVB_WINDOWS_TEST_APP_EXECUTABLE;
    if (override !== undefined && override.length > 0) {
        return override;
    }
    const localAppData = env.LOCALAPPDATA;
    if (localAppData === undefined || localAppData.length === 0) {
        throw new Error('LOCALAPPDATA is not set; the per-user install path cannot be resolved');
    }
    return joinGuestPath(separator, localAppData, ...DEFAULT_INSTALL_RELATIVE_PATH);
}

const PE_MACHINE_ARM64 = 0xaa64;
const PE_MACHINE_AMD64 = 0x8664;

export function readWindowsExecutableArchitecture(bytes: Uint8Array): TWindowsTestArchitecture | null {
    if (bytes.byteLength < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const peHeaderOffset = view.getUint32(0x3c, true);
    if (peHeaderOffset + 6 > bytes.byteLength) {
        return null;
    }
    if (view.getUint32(peHeaderOffset, true) !== 0x0000_4550) {
        return null;
    }
    const machine = view.getUint16(peHeaderOffset + 4, true);
    if (machine === PE_MACHINE_ARM64) {
        return 'arm64';
    }
    return machine === PE_MACHINE_AMD64 ? 'x64' : null;
}

export interface IInstalledExecutableIdentity {
    executablePath: string;
    sha256: string;
    architecture: TWindowsTestArchitecture;
}

export interface IVerifyInstalledExecutableOptions {
    fs: IGuestFileSystem;
    executablePath: string;
    expectedArchitecture: TWindowsTestArchitecture;
    expectedSha256?: string;
}

export async function verifyInstalledExecutable(
    options: IVerifyInstalledExecutableOptions,
): Promise<IInstalledExecutableIdentity> {
    const bytes = await options.fs.readBytes(options.executablePath);
    const sha256 = sha256Hex(bytes);
    if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256) {
        throw new Error(
            `Installed executable sha256 ${sha256} does not match the expected record ${options.expectedSha256}`,
        );
    }
    const architecture = readWindowsExecutableArchitecture(bytes);
    if (architecture === null) {
        throw new Error(`${options.executablePath} is not a recognizable x64 or arm64 Windows executable`);
    }
    if (architecture !== options.expectedArchitecture) {
        throw new Error(
            `Installed executable is ${architecture} but the job expects ${options.expectedArchitecture}`,
        );
    }
    return {
        executablePath: options.executablePath,
        sha256,
        architecture,
    };
}

export interface IOwnedProcessRecord {
    pid: number;
    startTime: string;
    executable: string;
}

export function matchesOwnedProcess(owned: IOwnedProcessRecord, candidate: IOwnedProcessRecord) {
    return owned.pid === candidate.pid
        && owned.startTime === candidate.startTime
        && owned.executable === candidate.executable;
}

export interface ITerminationOutcome {
    terminated: boolean;
    reason: string;
}

export interface IGuestProcessHandle {
    kill(): void;
    isAlive(): boolean;
}

export interface IGuestProcessSpawnOptions {env?: NodeJS.ProcessEnv;}

export interface IGuestProcessSpawner {spawn(executable: string, args: readonly string[], options?: IGuestProcessSpawnOptions): IGuestProcessHandle & { pid: number };}

export function createNodeProcessSpawner(): IGuestProcessSpawner {
    return { spawn: (executable, args, options) => {
        const child = spawn(executable, [...args], {
            windowsHide: false,
            stdio: 'ignore',
            ...(options?.env === undefined ? {} : {env: options.env}),
        });
        const state: {
            spawnError: Error | null;
            exited: boolean;
        } = {
            spawnError: null,
            exited: false,
        };
        // Without a listener an asynchronous spawn failure (ENOENT, EACCES)
        // surfaces as an unhandled 'error' event that kills the whole worker.
        child.on('error', (error) => {
            state.spawnError = error;
        });
        // exitCode stays null after a signal kill from outside, so the exit
        // event is the only reliable liveness signal.
        child.once('exit', () => {
            state.exited = true;
        });
        const pid = child.pid;
        if (pid === undefined) {
            throw new Error(`Failed to start ${executable}`);
        }
        child.unref();
        return {
            pid,
            kill: () => {
                child.kill();
            },
            isAlive: () => state.spawnError === null && !state.exited,
        };
    } };
}

export interface IOwnedProcessRegistry {
    register(record: IOwnedProcessRecord, handle: IGuestProcessHandle): void;
    records(): IOwnedProcessRecord[];
    terminateOwned(record: IOwnedProcessRecord): ITerminationOutcome;
    terminateAllOwned(): ITerminationOutcome[];
}

export function createOwnedProcessRegistry(): IOwnedProcessRegistry {
    const owned = new Map<number, {
        record: IOwnedProcessRecord;
        handle: IGuestProcessHandle
    }>();

    const terminateOwned = (record: IOwnedProcessRecord): ITerminationOutcome => {
        const entry = owned.get(record.pid);
        if (entry === undefined) {
            return {
                terminated: false,
                reason: `pid ${record.pid} is not owned by this worker; refusing to terminate`,
            };
        }
        if (!matchesOwnedProcess(entry.record, record)) {
            return {
                terminated: false,
                reason: `pid ${record.pid} identity changed (start time or executable differs); refusing to terminate`,
            };
        }
        if (!entry.handle.isAlive()) {
            owned.delete(record.pid);
            return {
                terminated: false,
                reason: `pid ${record.pid} already exited`,
            };
        }
        entry.handle.kill();
        owned.delete(record.pid);
        return {
            terminated: true,
            reason: `terminated owned pid ${record.pid}`,
        };
    };

    return {
        register: (record, handle) => {
            owned.set(record.pid, {
                record,
                handle,
            });
        },
        records: () => [...owned.values()].map(entry => entry.record),
        terminateOwned,
        terminateAllOwned: () => [...owned.values()].map(entry => terminateOwned(entry.record)),
    };
}

export interface IAppLaunchRequest {
    profile: TWindowsLaunchProfile;
    documentPath?: string;
    remoteDebuggingPort?: number;
    userDataDirectory?: string;
}

export interface IAppLaunchRecord {
    profile: TWindowsLaunchProfile;
    process: IOwnedProcessRecord;
    args: string[];
    browserUrl: string | null;
}

export interface ICreateWindowsAppLauncherOptions {
    clock: IGuestClock;
    spawner: IGuestProcessSpawner;
    registry: IOwnedProcessRegistry;
    executable: IInstalledExecutableIdentity;
    environment?: NodeJS.ProcessEnv;
}

export interface IWindowsAppLauncher {
    launch(request: IAppLaunchRequest): IAppLaunchRecord;
    terminate(record: IAppLaunchRecord): ITerminationOutcome;
}

const RENDERER_FILE_OPEN_HELPER_ENV = 'EVB_ENABLE_RENDERER_FILE_OPEN_HELPER';

export function buildLaunchEnvironment(
    profile: TWindowsLaunchProfile,
    userDataDirectory: string | undefined,
    baseEnvironment: NodeJS.ProcessEnv = process.env,
) {
    const launchEnvironment = {...baseEnvironment};
    for (const key of Object.keys(launchEnvironment)) {
        const normalizedKey = key.toUpperCase();
        if (normalizedKey.startsWith('EVB_AUTOMATION_') || normalizedKey === RENDERER_FILE_OPEN_HELPER_ENV) {
            Reflect.deleteProperty(launchEnvironment, key);
        }
    }
    if (profile === 'instrumentation') {
        if (userDataDirectory === undefined) {
            throw new Error('The instrumentation profile requires an isolated user data directory');
        }
        launchEnvironment.EVB_AUTOMATION_USER_DATA_DIR = userDataDirectory;
        launchEnvironment.EVB_AUTOMATION_SESSION_NAME = `evb-windows-test-${randomUUID()}`;
        launchEnvironment[RENDERER_FILE_OPEN_HELPER_ENV] = '1';
    }
    return launchEnvironment;
}

export function createWindowsAppLauncher({
    clock,
    spawner,
    registry,
    executable,
    environment = process.env,
}: ICreateWindowsAppLauncherOptions): IWindowsAppLauncher {
    return {
        launch: (request) => {
            const args = buildLaunchArguments({
                profile: request.profile,
                ...(request.remoteDebuggingPort === undefined ? {} : { remoteDebuggingPort: request.remoteDebuggingPort }),
                ...(request.userDataDirectory === undefined ? {} : { userDataDirectory: request.userDataDirectory }),
                ...(request.documentPath === undefined ? {} : { documentPath: request.documentPath }),
            });
            const launchEnvironment = buildLaunchEnvironment(
                request.profile,
                request.userDataDirectory,
                environment,
            );
            const handle = spawner.spawn(executable.executablePath, args, {env: launchEnvironment});
            const processRecord: IOwnedProcessRecord = {
                pid: handle.pid,
                startTime: clock.nowIso(),
                executable: executable.executablePath,
            };
            registry.register(processRecord, handle);
            return {
                profile: request.profile,
                process: processRecord,
                args,
                browserUrl: request.profile === 'instrumentation' && request.remoteDebuggingPort !== undefined
                    ? `http://127.0.0.1:${request.remoteDebuggingPort}`
                    : null,
            };
        },
        terminate: record => registry.terminateOwned(record.process),
    };
}

export async function connectInstrumentationBrowser(browserUrl: string, protocolTimeoutMs = 420_000) {
    return puppeteer.connect({
        browserURL: browserUrl,
        defaultViewport: null,
        protocolTimeout: protocolTimeoutMs,
    });
}
