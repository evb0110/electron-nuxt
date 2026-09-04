import { readFile } from 'node:fs/promises';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    WINDOWS_TEST_SCHEMA_VERSION,
    isVmUuid,
    windowsTestArchitectures,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import type { TWindowsTestArchitecture } from '@scripts/windows-test/contracts/windowsTestContracts';

export const windowsTestDiskResetPolicies = [
    'restore-from-baseline',
    'recreate-empty',
    'read-only-fixture',
    'preserve-within-scenario',
] as const;

export type TWindowsTestDiskResetPolicy = typeof windowsTestDiskResetPolicies[number];

export interface IWindowsTestImageDisk {
    diskId: string;
    purpose: string;
    resetPolicy: TWindowsTestDiskResetPolicy;
}

export interface IWindowsTestImageQualification {
    qualifiedBy: string;
    runnerVersion: string;
    coldResetCycles: number;
    notes: string;
}

export interface IWindowsTestImageManifest {
    schemaVersion: typeof WINDOWS_TEST_SCHEMA_VERSION;
    imageId: string;
    vmId: string;
    bundlePath: string;
    createdAt: string;
    windowsBuild: string;
    osArch: TWindowsTestArchitecture;
    utmVersion: string;
    qemuVersion: string;
    driverVersions: Record<string, string>;
    disks: IWindowsTestImageDisk[];
    guestTestMarker: string;
    qualifiedAt: string | null;
    qualification: IWindowsTestImageQualification | null;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string');
}

export function isWindowsTestImageDisk(value: unknown): value is IWindowsTestImageDisk {
    return isRecord(value)
        && isNonEmptyString(value.diskId)
        && isNonEmptyString(value.purpose)
        && isOneOf(windowsTestDiskResetPolicies, value.resetPolicy);
}

export function isWindowsTestImageQualification(value: unknown): value is IWindowsTestImageQualification {
    return isRecord(value)
        && isNonEmptyString(value.qualifiedBy)
        && isNonEmptyString(value.runnerVersion)
        && typeof value.coldResetCycles === 'number'
        && Number.isInteger(value.coldResetCycles)
        && value.coldResetCycles >= 0
        && typeof value.notes === 'string';
}

export function isWindowsTestImageManifest(value: unknown): value is IWindowsTestImageManifest {
    return isRecord(value)
        && value.schemaVersion === WINDOWS_TEST_SCHEMA_VERSION
        && isNonEmptyString(value.imageId)
        && isVmUuid(value.vmId)
        && isNonEmptyString(value.bundlePath)
        && isNonEmptyString(value.createdAt)
        && isNonEmptyString(value.windowsBuild)
        && isOneOf(windowsTestArchitectures, value.osArch)
        && isNonEmptyString(value.utmVersion)
        && isNonEmptyString(value.qemuVersion)
        && isStringRecord(value.driverVersions)
        && Array.isArray(value.disks)
        && value.disks.length > 0
        && value.disks.every(isWindowsTestImageDisk)
        && isNonEmptyString(value.guestTestMarker)
        && (value.qualifiedAt === null || isNonEmptyString(value.qualifiedAt))
        && (value.qualification === null || isWindowsTestImageQualification(value.qualification));
}

export function isQualifiedWindowsTestImage(manifest: IWindowsTestImageManifest) {
    return manifest.qualifiedAt !== null && manifest.qualification !== null;
}

export function parseWindowsTestImageManifest(value: unknown, sourcePath: string): IWindowsTestImageManifest {
    if (!isWindowsTestImageManifest(value)) {
        throw new Error(`Windows test image manifest ${sourcePath} does not match the image manifest schema.`);
    }
    return value;
}

export async function loadWindowsTestImageManifest(manifestPath: string) {
    const raw = await readFile(manifestPath, 'utf8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Windows test image manifest ${manifestPath} is not valid JSON: ${String(error)}.`);
    }
    return parseWindowsTestImageManifest(parsed, manifestPath);
}
