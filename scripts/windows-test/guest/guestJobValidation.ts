import { isRecord } from '@contracts/runtimeGuards';
import {
    WINDOWS_TEST_RUNNER_VERSION,
    isWindowsTestJob,
    type IWindowsTestJob,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    isPathInsideGuestRoot,
    joinGuestPath,
    type IGuestLayout,
    type IGuestRunPaths,
} from '@scripts/windows-test/guest/guestPaths';
import {
    sha256Hex,
    type IGuestFileSystem,
} from '@scripts/windows-test/guest/guestRuntime';

export interface IGuestTestMarkerRecord {
    guestTestMarker: string;
    imageId: string;
}

export function isGuestTestMarkerRecord(value: unknown): value is IGuestTestMarkerRecord {
    return isRecord(value)
        && typeof value.guestTestMarker === 'string'
        && value.guestTestMarker.length > 0
        && typeof value.imageId === 'string'
        && value.imageId.length > 0;
}

export interface IGuestJobAccepted {
    ok: true;
    job: IWindowsTestJob;
}

export interface IGuestJobRejected {
    ok: false;
    reason: string;
    job: IWindowsTestJob | null;
}

export type TGuestJobValidation = IGuestJobAccepted | IGuestJobRejected;

export interface IValidateGuestJobOptions {
    fs: IGuestFileSystem;
    layout: IGuestLayout;
    paths: IGuestRunPaths;
    markerRunId: string;
    rawJob: unknown;
    expectedRunnerVersion?: string;
}

function reject(reason: string, job: IWindowsTestJob | null = null): IGuestJobRejected {
    return {
        ok: false,
        reason,
        job,
    };
}

export function isSafeStagedFileName(fileName: string) {
    return fileName.length > 0
        && !fileName.includes('..')
        && !fileName.includes('/')
        && !fileName.includes('\\')
        && !fileName.includes(':');
}

async function hashStagedFile(fs: IGuestFileSystem, filePath: string) {
    if (!await fs.exists(filePath)) {
        return null;
    }
    return sha256Hex(await fs.readBytes(filePath));
}

export async function validateGuestJob({
    fs,
    layout,
    paths,
    markerRunId,
    rawJob,
    expectedRunnerVersion = WINDOWS_TEST_RUNNER_VERSION,
}: IValidateGuestJobOptions): Promise<TGuestJobValidation> {
    if (isRecord(rawJob) && rawJob.schemaVersion !== undefined && !isWindowsTestJob(rawJob)) {
        const declared: unknown = rawJob.schemaVersion;
        if (typeof declared === 'number' && declared !== 1) {
            return reject(`job declares unsupported schemaVersion ${declared}`);
        }
    }
    if (!isWindowsTestJob(rawJob)) {
        return reject('job does not match the windows test job schema');
    }
    const job = rawJob;
    if (job.runId !== markerRunId) {
        return reject(`job runId ${job.runId} does not match ready marker ${markerRunId}`, job);
    }
    if (job.runnerVersion !== expectedRunnerVersion) {
        return reject(
            `job runnerVersion ${job.runnerVersion} is not the installed worker version ${expectedRunnerVersion}`,
            job,
        );
    }
    if (await fs.exists(paths.startedMarkerFile)) {
        return reject(`run ${job.runId} already started on this guest; duplicate execution refused`, job);
    }
    if (!isPathInsideGuestRoot(layout, paths.runRoot) || !isPathInsideGuestRoot(layout, paths.stagingDir)) {
        return reject('resolved run paths fall outside the guest test root', job);
    }
    if (!isSafeStagedFileName(job.artifactFileName)) {
        return reject(`artifactFileName ${job.artifactFileName} is not a plain staged file name`, job);
    }

    const bootId = (await fs.readText(layout.bootIdFile).catch(() => '')).trim();
    if (bootId.length === 0) {
        return reject('guest boot id file is missing or empty', job);
    }
    if (bootId !== job.bootId) {
        return reject(`job bootId ${job.bootId} does not match the current guest boot ${bootId}`, job);
    }

    const markerText = await fs.readText(layout.markerFile).catch(() => '');
    let markerRecord: unknown = null;
    try {
        markerRecord = markerText.length === 0 ? null : JSON.parse(markerText);
    } catch {
        markerRecord = null;
    }
    if (!isGuestTestMarkerRecord(markerRecord)) {
        return reject('guest test marker file is missing or malformed', job);
    }
    if (markerRecord.guestTestMarker !== job.guestTestMarker) {
        return reject(
            `job guestTestMarker ${job.guestTestMarker} does not match the provisioned guest marker`,
            job,
        );
    }

    const artifactPath = joinGuestPath(layout.separator, paths.stagingDir, job.artifactFileName);
    if (!isPathInsideGuestRoot(layout, artifactPath)) {
        return reject('staged artifact path falls outside the guest test root', job);
    }
    const artifactSha256 = await hashStagedFile(fs, artifactPath);
    if (artifactSha256 === null) {
        return reject(`staged artifact ${job.artifactFileName} is missing`, job);
    }
    if (artifactSha256 !== job.artifactSha256) {
        return reject(
            `staged artifact sha256 ${artifactSha256} does not match the job value ${job.artifactSha256}`,
            job,
        );
    }

    const fixtureManifestSha256 = await hashStagedFile(fs, paths.fixtureManifestFile);
    if (fixtureManifestSha256 === null) {
        return reject('staged fixture manifest is missing', job);
    }
    if (fixtureManifestSha256 !== job.fixtureManifestSha256) {
        return reject(
            `staged fixture manifest sha256 ${fixtureManifestSha256} does not match the job value ${job.fixtureManifestSha256}`,
            job,
        );
    }

    return {
        ok: true,
        job,
    };
}
