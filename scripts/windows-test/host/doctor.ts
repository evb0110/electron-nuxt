import {
    stat,
    statfs,
} from 'node:fs/promises';
import type {
    ICommandRunner,
    IUtmctlClient,
} from '@scripts/windows-test/host/utmctlClient';
import type { IWindowsTestHostLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import {
    WindowsTestConfigError,
    loadWindowsTestHostConfig,
} from '@scripts/windows-test/host/hostConfig';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';

export interface IWindowsTestDoctorCheck {
    id: string;
    ok: boolean;
    detail: string;
    remedy: string;
}

export interface IWindowsTestDoctorReport {
    ok: boolean;
    checks: IWindowsTestDoctorCheck[];
}

export interface IWindowsTestSessionProbe {managerName(): Promise<string | null>;}

// `utmctl` drives UTM through ScriptingBridge, which only works from a real Aqua
// session. `launchctl managername` is the cheapest way to tell an Aqua login
// apart from an SSH or pre-login context.
export function createLaunchctlSessionProbe(
    runner: ICommandRunner,
    options: {
        launchctlPath?: string;
        timeoutMs?: number;
    } = {},
): IWindowsTestSessionProbe {
    const launchctlPath = options.launchctlPath ?? '/bin/launchctl';
    const timeoutMs = options.timeoutMs ?? 5_000;
    return {managerName: async () => {
        const result = await runner
            .run(launchctlPath, ['managername'], {timeoutMs})
            .catch(() => null);
        if (result === null || result.exitCode !== 0) {
            return null;
        }
        const name = result.stdout.trim();
        return name.length === 0 ? null : name;
    }};
}

export const UTMCTL_VERSION_PATTERN = /\d+\.\d+(?:\.\d+)?/u;

export function parseUtmctlVersion(text: string) {
    const match = UTMCTL_VERSION_PATTERN.exec(text);
    return match === null ? null : match[0];
}

export interface IWindowsTestDoctorDependencies {
    layout: IWindowsTestHostLayout;
    utmctl: IUtmctlClient;
    sessionProbe: IWindowsTestSessionProbe;
    env: NodeJS.ProcessEnv;
    launcherPath: string;
    hashFile(filePath: string): Promise<string>;
    freeBytes?(target: string): Promise<number | null>;
    loadConfig?(configFile: string): Promise<IWindowsTestHostConfig>;
}

export async function nodeFreeBytes(target: string) {
    const stats = await statfs(target).catch(() => null);
    return stats === null ? null : stats.bsize * stats.bavail;
}

function check(id: string, ok: boolean, detail: string, remedy: string): IWindowsTestDoctorCheck {
    return {
        id,
        ok,
        detail,
        remedy,
    };
}

async function directoryExists(target: string) {
    const stats = await stat(target).catch(() => null);
    return stats !== null && stats.isDirectory();
}

async function checkSession(dependencies: IWindowsTestDoctorDependencies) {
    const sshConnection = dependencies.env.SSH_CONNECTION;
    if (sshConnection !== undefined && sshConnection.length > 0) {
        return check(
            'gui-session',
            false,
            'SSH_CONNECTION is set, so this shell is not a macOS GUI session.',
            'Run the Windows lane from a Terminal window inside a logged-in Aqua session; utmctl cannot reach UTM over SSH.',
        );
    }
    const managerName = await dependencies.sessionProbe.managerName();
    return check(
        'gui-session',
        managerName === 'Aqua',
        `launchctl managername reported ${managerName ?? 'nothing'}.`,
        'Run the lane from a logged-in Aqua session; a pre-login or SSH context cannot script UTM.',
    );
}

async function checkUtmctl(dependencies: IWindowsTestDoctorDependencies) {
    const checks: IWindowsTestDoctorCheck[] = [];
    let version: string | null = null;
    try {
        version = parseUtmctlVersion(await dependencies.utmctl.version());
    } catch (error) {
        checks.push(check(
            'utmctl-present',
            false,
            `utmctl version failed: ${error instanceof Error ? error.message : String(error)}.`,
            'Install UTM and confirm /Applications/UTM.app/Contents/MacOS/utmctl is executable.',
        ));
        return checks;
    }
    checks.push(check(
        'utmctl-present',
        version !== null,
        `utmctl reported version ${version ?? 'in an unparsable form'}.`,
        'Install a UTM build whose utmctl prints a parsable version.',
    ));

    try {
        const registered = await dependencies.utmctl.list();
        checks.push(check(
            'automation-consent',
            true,
            `utmctl listed ${registered.length} registered virtual machines.`,
            'No action needed.',
        ));
    } catch (error) {
        checks.push(check(
            'automation-consent',
            false,
            `utmctl list failed: ${error instanceof Error ? error.message : String(error)}.`,
            'Grant the qualified launcher Automation access to UTM in System Settings > Privacy & Security > Automation, then retry.',
        ));
    }
    return checks;
}

async function checkGoldenImage(
    dependencies: IWindowsTestDoctorDependencies,
    config: IWindowsTestHostConfig,
) {
    try {
        const status = await dependencies.utmctl.status(config.goldenVmId);
        return check(
            'golden-image-stopped',
            status === 'stopped',
            `The golden image ${config.goldenVmId} reports status "${status}".`,
            'Stop the golden image; every run must clone an identical stopped baseline.',
        );
    } catch (error) {
        return check(
            'golden-image-stopped',
            false,
            `The golden image ${config.goldenVmId} could not be queried: ${error instanceof Error ? error.message : String(error)}.`,
            'Register the golden image in UTM and record its UUID as goldenVmId.',
        );
    }
}

function checkAllowlist(config: IWindowsTestHostConfig) {
    const golden = config.goldenVmId.toLowerCase();
    const allowlisted = config.allowedTestVmIds.map(vmId => vmId.toLowerCase());
    const overlapsGolden = allowlisted.includes(golden);
    const overlapsDenied = allowlisted.some(vmId => config.personalVmIdsDenied.includes(vmId));
    return check(
        'allowlist-sane',
        allowlisted.length > 0 && !overlapsGolden && !overlapsDenied,
        `allowedTestVmIds holds ${allowlisted.length} UUIDs, golden overlap: ${String(overlapsGolden)}, denied overlap: ${String(overlapsDenied)}.`,
        'List only disposable test VM UUIDs in allowedTestVmIds and keep the golden and personal UUIDs out of it.',
    );
}

async function checkCandidate(
    dependencies: IWindowsTestDoctorDependencies,
    config: IWindowsTestHostConfig,
) {
    if (config.candidate === null) {
        return check(
            'candidate-artifact',
            false,
            'No candidate artifact is recorded in the host configuration.',
            'Run the lane with --artifact <absolute path> to record a candidate build.',
        );
    }
    const stats = await stat(config.candidate.artifactPath).catch(() => null);
    if (stats === null || !stats.isFile()) {
        return check(
            'candidate-artifact',
            false,
            `The candidate artifact ${config.candidate.artifactPath} is missing.`,
            'Re-stage the candidate artifact with --artifact <absolute path>.',
        );
    }
    const observed = await dependencies.hashFile(config.candidate.artifactPath).catch(() => null);
    return check(
        'candidate-artifact',
        observed === config.candidate.sha256,
        `The candidate artifact hashes to ${observed ?? 'nothing readable'} against the recorded ${config.candidate.sha256}.`,
        'Re-stage the candidate artifact so its recorded sha256 matches the file on disk.',
    );
}

export async function runWindowsTestDoctor(
    dependencies: IWindowsTestDoctorDependencies,
): Promise<IWindowsTestDoctorReport> {
    const freeBytes = dependencies.freeBytes ?? nodeFreeBytes;
    const loadConfig = dependencies.loadConfig ?? loadWindowsTestHostConfig;
    const checks: IWindowsTestDoctorCheck[] = [await checkSession(dependencies)];
    checks.push(...await checkUtmctl(dependencies));

    let config: IWindowsTestHostConfig | null = null;
    try {
        config = await loadConfig(dependencies.layout.configFile);
        checks.push(check(
            'config-present',
            true,
            `Loaded host configuration from ${dependencies.layout.configFile}.`,
            'No action needed.',
        ));
    } catch (error) {
        checks.push(check(
            'config-present',
            false,
            error instanceof WindowsTestConfigError
                ? `${error.kind}: ${error.message}`
                : `The host configuration could not be loaded: ${error instanceof Error ? error.message : String(error)}.`,
            `Create ${dependencies.layout.configFile} and record the golden image, the test VM allowlist and the retention policy.`,
        ));
    }

    const cacheDirectories = [
        {
            label: 'artifacts',
            cacheDir: dependencies.layout.artifactsCacheDir,
        },
        {
            label: 'fixtures',
            cacheDir: dependencies.layout.fixturesCacheDir,
        },
        {
            label: 'tools',
            cacheDir: dependencies.layout.toolsCacheDir,
        },
    ];
    for (const {
        label,
        cacheDir,
    } of cacheDirectories) {
        checks.push(check(
            `cache-directory-${label}`,
            await directoryExists(cacheDir),
            `Cache directory ${cacheDir}.`,
            `Create ${cacheDir} so staged inputs are cached between runs.`,
        ));
    }

    if (config === null) {
        return {
            ok: checks.every(entry => entry.ok),
            checks,
        };
    }

    checks.push(await checkGoldenImage(dependencies, config));
    checks.push(checkAllowlist(config));
    checks.push(check(
        'test-image-root',
        await directoryExists(config.testImageRoot),
        `Test image root ${config.testImageRoot}.`,
        'Create the configured test image root and keep every disposable clone inside it.',
    ));

    const observedFreeBytes = await freeBytes(config.testImageRoot).catch(() => null);
    checks.push(check(
        'free-disk-space',
        observedFreeBytes !== null && observedFreeBytes >= config.retention.minFreeBytes,
        `${String(observedFreeBytes)} bytes free against the required ${config.retention.minFreeBytes}.`,
        'Free disk space or delete retained failed clones before running the lane.',
    ));
    checks.push(await checkCandidate(dependencies, config));
    checks.push(check(
        'launcher-qualified',
        config.qualifiedLaunchers.includes(dependencies.launcherPath),
        `Launcher ${dependencies.launcherPath} against ${config.qualifiedLaunchers.length} qualified launchers.`,
        'Add this launcher to qualifiedLaunchers after granting it Automation consent for UTM.',
    ));

    return {
        ok: checks.every(entry => entry.ok),
        checks,
    };
}
