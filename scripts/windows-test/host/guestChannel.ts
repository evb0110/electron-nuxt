import {
    readFile,
    rm,
} from 'node:fs/promises';
import {
    isWindowsTestWorkerHeartbeat,
    windowsTestDefaultDeadlines,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import type {
    IWindowsTestJob,
    IWindowsTestWorkerHeartbeat,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    windowsTestGuestLayout,
    windowsTestGuestRunPaths,
} from '@scripts/windows-test/contracts/windowsTestPaths';
import type { IUtmctlClient } from '@scripts/windows-test/host/utmctlClient';

// PowerShell is invoked through a staged script file with separate argv
// entries. Interpolating a guest path or a document name into a command string
// would let file content act as code.
export const GUEST_FILE_HASH_SCRIPT_PATH = `${windowsTestGuestLayout.stateDir}\\verify-file-hash.ps1`;

export const GUEST_FILE_HASH_SCRIPT = [
    'param(',
    '    [Parameter(Mandatory = $true)][string]$TargetPath,',
    '    [Parameter(Mandatory = $true)][string]$ExpectedSha256',
    ')',
    '$ErrorActionPreference = \'Stop\'',
    'if (-not (Test-Path -LiteralPath $TargetPath)) {',
    '    Write-Output \'missing\'',
    '    exit 2',
    '}',
    '$actual = (Get-FileHash -LiteralPath $TargetPath -Algorithm SHA256).Hash.ToLowerInvariant()',
    'if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {',
    '    Write-Output "mismatch $actual"',
    '    exit 3',
    '}',
    'Write-Output "match $actual"',
    'exit 0',
    '',
].join('\n');

export const GUEST_POWERSHELL_COMMAND = [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
] as const;

// The path is supplied over stdin, never interpolated into the command. This
// keeps directory creation safe for every guest path the host derives from a
// run id or a prepared fixture name.
const GUEST_MAKE_DIRECTORY_COMMAND = [
    '$ErrorActionPreference = \'Stop\'',
    '$path = [Console]::In.ReadToEnd().Trim()',
    'if ([string]::IsNullOrWhiteSpace($path)) { exit 2 }',
    'New-Item -ItemType Directory -LiteralPath $path -Force | Out-Null',
].join('; ');

export interface IWindowsTestGuestChannel {
    ping(vmId: string, timeoutMs: number): Promise<boolean>;
    ensureDirectory(vmId: string, guestPath: string, timeoutMs: number): Promise<void>;
    readHeartbeat(vmId: string, timeoutMs: number): Promise<IWindowsTestWorkerHeartbeat | null>;
    stageFile(vmId: string, hostPath: string, guestPath: string, timeoutMs: number): Promise<void>;
    stageText(vmId: string, contents: string, guestPath: string, timeoutMs: number): Promise<void>;
    verifyStagedFileHash(
        vmId: string,
        guestPath: string,
        expectedSha256: string,
        timeoutMs: number,
    ): Promise<boolean>;
    writeJob(vmId: string, job: IWindowsTestJob, timeoutMs: number): Promise<void>;
    publishReadyMarker(vmId: string, runId: string, timeoutMs: number): Promise<void>;
    requestGuestCancel(vmId: string, runId: string, timeoutMs: number): Promise<void>;
    readGuestText(vmId: string, guestPath: string, timeoutMs: number): Promise<string | null>;
    pullGuestFile(vmId: string, guestPath: string, hostPath: string, timeoutMs: number): Promise<boolean>;
}

const HEARTBEAT_READ_TIMEOUT_MS = windowsTestDefaultDeadlines.uiStepSeconds * 1_000;

export function createUtmctlGuestChannel(options: {
    client: IUtmctlClient;
    temporaryFilePath(label: string): string;
}): IWindowsTestGuestChannel {
    const readGuestText = async (vmId: string, guestPath: string, timeoutMs: number) => {
        const hostPath = options.temporaryFilePath('guest-read');
        try {
            await options.client.pullFile(vmId, guestPath, hostPath, {timeoutMs});
            return await readFile(hostPath, 'utf8');
        } catch {
            return null;
        } finally {
            await rm(hostPath, {force: true});
        }
    };

    return {
        ping: async (vmId, timeoutMs) => {
            const outcome = await options.client.exec(vmId, [
                ...GUEST_POWERSHELL_COMMAND,
                '-Command',
                'exit 0',
            ], {timeoutMs});
            // Transport health only: a guest-ready probe never implies that any
            // test work succeeded.
            return outcome.transportFailure === null && outcome.exitCode === 0;
        },
        ensureDirectory: async (vmId, guestPath, timeoutMs) => {
            const outcome = await options.client.exec(vmId, [
                ...GUEST_POWERSHELL_COMMAND,
                '-Command',
                GUEST_MAKE_DIRECTORY_COMMAND,
            ], {
                timeoutMs,
                input: `${guestPath}\n`,
            });
            if (outcome.transportFailure !== null || outcome.exitCode !== 0) {
                throw new Error(`Could not create guest directory ${guestPath}: ${outcome.stderr.trim()}`);
            }
        },
        readHeartbeat: async (vmId, timeoutMs) => {
            const text = await readGuestText(vmId, windowsTestGuestLayout.heartbeatFile, timeoutMs);
            if (text === null) {
                return null;
            }
            try {
                const parsed: unknown = JSON.parse(text);
                return isWindowsTestWorkerHeartbeat(parsed) ? parsed : null;
            } catch {
                return null;
            }
        },
        stageFile: async (vmId, hostPath, guestPath, timeoutMs) => {
            await options.client.pushFile(vmId, guestPath, await readFile(hostPath), {timeoutMs});
        },
        stageText: async (vmId, contents, guestPath, timeoutMs) => {
            await options.client.pushFile(vmId, guestPath, contents, {timeoutMs});
        },
        verifyStagedFileHash: async (vmId, guestPath, expectedSha256, timeoutMs) => {
            const expected = expectedSha256.toLowerCase();
            await options.client.pushFile(
                vmId,
                GUEST_FILE_HASH_SCRIPT_PATH,
                GUEST_FILE_HASH_SCRIPT,
                {timeoutMs: HEARTBEAT_READ_TIMEOUT_MS},
            );
            const outcome = await options.client.exec(vmId, [
                ...GUEST_POWERSHELL_COMMAND,
                '-File',
                GUEST_FILE_HASH_SCRIPT_PATH,
                guestPath,
                expected,
            ], {timeoutMs});
            return outcome.transportFailure === null
                && outcome.exitCode === 0
                && outcome.stdout.toLowerCase().includes(`match ${expected}`);
        },
        writeJob: async (vmId, job, timeoutMs) => {
            await options.client.pushFile(
                vmId,
                windowsTestGuestRunPaths(job.runId).jobFile,
                `${JSON.stringify(job, null, 4)}\n`,
                {timeoutMs},
            );
        },
        publishReadyMarker: async (vmId, runId, timeoutMs) => {
            await options.client.pushFile(
                vmId,
                windowsTestGuestRunPaths(runId).readyMarkerFile,
                `${runId}\n`,
                {timeoutMs},
            );
        },
        requestGuestCancel: async (vmId, runId, timeoutMs) => {
            await options.client.pushFile(
                vmId,
                windowsTestGuestRunPaths(runId).cancelFile,
                `${runId}\n`,
                {timeoutMs},
            );
        },
        readGuestText,
        pullGuestFile: async (vmId, guestPath, hostPath, timeoutMs) => {
            try {
                await options.client.pullFile(vmId, guestPath, hostPath, {timeoutMs});
                return true;
            } catch {
                return false;
            }
        },
    };
}
