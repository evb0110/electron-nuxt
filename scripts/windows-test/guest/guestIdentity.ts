import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';
import type {
    IWindowsTestWorkerIdentity,
    TWindowsTestArchitecture,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import type { IGuestPowerShellRunner } from '@scripts/windows-test/guest/guestPowerShell';

export const EXPECTED_INPUT_DESKTOP = 'Default';

export interface IGuestIdentityProbePayload {
    userSid: string;
    sessionId: number;
    integrityLevel: string;
    inputDesktop: string;
    logonUiPresent: boolean;
    workerPid: number;
    workerStartTime: string;
    osVersion: string;
    osArchitecture: string;
    hostname: string;
    appVersion: string;
}

export interface IGuestEnvironmentProbe {
    identity: IWindowsTestWorkerIdentity;
    osVersion: string;
    osArch: TWindowsTestArchitecture | null;
    hostname: string;
    appVersion: string;
    logonUiPresent: boolean;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

export function isGuestIdentityProbePayload(value: unknown): value is IGuestIdentityProbePayload {
    return isRecord(value)
        && isNonEmptyString(value.userSid)
        && isFiniteNumber(value.sessionId)
        && isNonEmptyString(value.integrityLevel)
        && typeof value.inputDesktop === 'string'
        && typeof value.logonUiPresent === 'boolean'
        && isFiniteNumber(value.workerPid)
        && isNonEmptyString(value.workerStartTime)
        && isNonEmptyString(value.osVersion)
        && isNonEmptyString(value.osArchitecture)
        && isNonEmptyString(value.hostname)
        && typeof value.appVersion === 'string';
}

export function normalizeWindowsArchitecture(value: string): TWindowsTestArchitecture | null {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'arm64' || normalized === 'aarch64') {
        return 'arm64';
    }
    if (normalized === 'amd64' || normalized === 'x64' || normalized === 'x86_64') {
        return 'x64';
    }
    return null;
}

export function parseGuestEnvironmentProbe(value: unknown): IGuestEnvironmentProbe {
    if (!isGuestIdentityProbePayload(value)) {
        throw new Error('Guest identity probe returned an unrecognized payload');
    }
    const inputDesktop = value.inputDesktop.length === 0 ? 'unavailable' : value.inputDesktop;
    return {
        identity: {
            userSid: value.userSid,
            sessionId: value.sessionId,
            integrityLevel: value.integrityLevel,
            inputDesktop,
            interactive: value.sessionId !== 0
                && inputDesktop === EXPECTED_INPUT_DESKTOP
                && !value.logonUiPresent,
            workerPid: value.workerPid,
            workerStartTime: value.workerStartTime,
        },
        osVersion: value.osVersion,
        osArch: normalizeWindowsArchitecture(value.osArchitecture),
        hostname: value.hostname,
        appVersion: value.appVersion.length === 0 ? 'unknown' : value.appVersion,
        logonUiPresent: value.logonUiPresent,
    };
}

export function describeNonInteractiveSession(probe: IGuestEnvironmentProbe) {
    if (probe.identity.sessionId === 0) {
        return 'worker runs in Session 0; a Session 0 launch is never a user journey (I9)';
    }
    if (probe.identity.inputDesktop !== EXPECTED_INPUT_DESKTOP) {
        return `input desktop is "${probe.identity.inputDesktop}" instead of "${EXPECTED_INPUT_DESKTOP}" (I9)`;
    }
    if (probe.logonUiPresent) {
        return 'the guest session is locked (LogonUI.exe present) (I9)';
    }
    return null;
}

export async function probeGuestEnvironment(
    powerShell: IGuestPowerShellRunner,
    executablePath: string,
    workerPid?: number,
) {
    const arguments_ = workerPid === undefined
        ? [executablePath]
        : [
            executablePath,
            '-WorkerPid',
            String(workerPid),
        ];
    return parseGuestEnvironmentProbe(await powerShell.runJson('probe-identity.ps1', arguments_));
}
