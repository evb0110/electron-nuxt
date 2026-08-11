import {randomUUID} from 'node:crypto';
import {
    lstat,
    rm,
} from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import type { IManagedTempFileHandle } from '@contracts/electronApiDocuments';
import {decodeManagedTempFileHandle} from '@contracts/electronApiDocuments';
import {
    decodeTypedStagedArtifact,
    type IStagedArtifactValidations,
    type ITypedStagedArtifact,
    type TArtifactFileIdentity,
} from '@contracts/stagedArtifacts';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';
import {
    resolveExistingReadableBinaryPath,
    resolveExistingReadableDocumentOrImagePath,
} from '@electron/features/documents/main/documentFilePathResolution';
import { readWorkingCopyRevisionSidecar } from '@electron/file-access/documentRevisionSidecar';
import {fingerprintFileWithUtilityProcess} from '@electron/features/documents/main/fingerprintFileWithUtilityProcess';

const MANAGED_HANDLE_TTL_MS = 5 * 60 * 1_000;

interface IMainManagedTempFileLease {
    ownerId: number | undefined;
    path: string;
    expiresAt: number;
    cleanupOnRelease: boolean;
}

interface IMainStagedArtifactLease extends IMainManagedTempFileLease {
    artifact: ITypedStagedArtifact;
    statWitness: IArtifactStatWitness;
    immutable: true;
}

interface IArtifactStatWitness {
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
}

const leases = new Map<string, IMainManagedTempFileLease | IMainStagedArtifactLease>();
let leaseSweepTimer: ReturnType<typeof setTimeout> | null = null;

function cloneTypedStagedArtifact(artifact: ITypedStagedArtifact): ITypedStagedArtifact {
    return {
        ...artifact,
        fileIdentity: {...artifact.fileIdentity},
        validations: {
            ...artifact.validations,
            ...(artifact.validations.qpdfResult === undefined
                ? {}
                : {qpdfResult: {
                    ...artifact.validations.qpdfResult,
                    errors: [...artifact.validations.qpdfResult.errors],
                    warnings: [...artifact.validations.qpdfResult.warnings],
                }}),
        },
    };
}

function createArtifactFileIdentity(fileStat: BigIntStats): TArtifactFileIdentity {
    return process.platform === 'win32'
        ? {
            platform: 'win32',
            volumeId: fileStat.dev.toString(),
            fileId: fileStat.ino.toString(),
        }
        : {
            platform: 'posix',
            deviceId: fileStat.dev.toString(),
            inode: fileStat.ino.toString(),
        };
}

function createArtifactStatWitness(fileStat: BigIntStats): IArtifactStatWitness {
    return {
        size: fileStat.size,
        mtimeNs: fileStat.mtimeNs,
        ctimeNs: fileStat.ctimeNs,
    };
}

function isSameArtifactStatWitness(
    left: IArtifactStatWitness,
    right: IArtifactStatWitness,
) {
    return left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}

async function statRegularArtifact(path: string) {
    const fileStat = await lstat(path, {bigint: true});
    if (!fileStat.isFile()) {
        throw new Error('Staged artifact path no longer identifies a regular file');
    }
    return fileStat;
}

function invalidateStagedArtifactLease(leaseId: string) {
    leases.delete(leaseId);
    sweepExpiredLeases();
}

function sweepExpiredLeases() {
    const now = Date.now();
    for (const [
        leaseId,
        lease,
    ] of leases) {
        if (lease.expiresAt <= now) {
            leases.delete(leaseId);
            if (lease.cleanupOnRelease) void rm(lease.path, {force: true});
        }
    }
    if (leases.size === 0 && leaseSweepTimer) {
        clearInterval(leaseSweepTimer);
        leaseSweepTimer = null;
    }
}

function ensureLeaseSweep() {
    leaseSweepTimer ??= setInterval(sweepExpiredLeases, 30_000);
    leaseSweepTimer.unref?.();
}

export async function createManagedTempFileHandle(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    options: {cleanupOnRelease?: boolean} = {},
): Promise<IManagedTempFileHandle> {
    const path = await resolveExistingReadableDocumentOrImagePath(filePath, context.senderId);
    const [
        inspection,
        revisionSidecar,
    ] = await Promise.all([
        fingerprintFileWithUtilityProcess(path),
        readWorkingCopyRevisionSidecar(path),
    ]);
    const leaseId = randomUUID();
    leases.set(leaseId, {
        ownerId: context.senderId,
        path,
        expiresAt: Date.now() + MANAGED_HANDLE_TTL_MS,
        cleanupOnRelease: options.cleanupOnRelease === true,
    });
    ensureLeaseSweep();
    return {
        path,
        size: inspection.bytes,
        sha256: inspection.sha256,
        leaseId,
        revision: revisionSidecar?.token ?? null,
    };
}

export async function createTypedStagedArtifact(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    validations: IStagedArtifactValidations,
    options: {
        cleanupOnRelease?: boolean;
        trustedFingerprint?: {
            bytes: number;
            sha256: string;
        };
    } = {},
): Promise<ITypedStagedArtifact> {
    const path = await resolveExistingReadableBinaryPath(filePath, context.senderId);
    const beforeStat = await statRegularArtifact(path);
    const trustedFingerprint = options.trustedFingerprint;
    if (
        trustedFingerprint !== undefined
        && (
            !Number.isSafeInteger(trustedFingerprint.bytes)
            || trustedFingerprint.bytes < 0
            || !/^[a-f0-9]{64}$/u.test(trustedFingerprint.sha256)
        )
    ) {
        throw new Error('Invalid trusted staged artifact fingerprint');
    }
    const [
        inspection,
        revisionSidecar,
    ] = await Promise.all([
        trustedFingerprint === undefined
            ? fingerprintFileWithUtilityProcess(path)
            : Promise.resolve(trustedFingerprint),
        readWorkingCopyRevisionSidecar(path),
    ]);
    const fileStat = await statRegularArtifact(path);
    if (
        BigInt(inspection.bytes) !== fileStat.size
        || !isDeepStrictEqual(
            createArtifactFileIdentity(beforeStat),
            createArtifactFileIdentity(fileStat),
        )
        || !isSameArtifactStatWitness(
            createArtifactStatWitness(beforeStat),
            createArtifactStatWitness(fileStat),
        )
    ) {
        throw new Error('Staged artifact changed while its receipt was being created');
    }
    const leaseId = randomUUID();
    const artifact: ITypedStagedArtifact = {
        receiptVersion: 1,
        artifactKind: 'pdf',
        path,
        size: inspection.bytes,
        sha256: inspection.sha256,
        fileIdentity: createArtifactFileIdentity(fileStat),
        validations: {
            ...validations,
            ...(validations.qpdfResult === undefined
                ? {}
                : {qpdfResult: {
                    ...validations.qpdfResult,
                    errors: [...validations.qpdfResult.errors],
                    warnings: [...validations.qpdfResult.warnings],
                }}),
        },
        leaseId,
        revision: revisionSidecar?.token ?? null,
    };
    const decodedArtifact = decodeTypedStagedArtifact(artifact);
    if (decodedArtifact === null) {
        throw new Error('Invalid staged artifact validation receipt');
    }
    const authoritativeArtifact = cloneTypedStagedArtifact(decodedArtifact);
    leases.set(leaseId, {
        ownerId: context.senderId,
        path,
        expiresAt: Date.now() + MANAGED_HANDLE_TTL_MS,
        cleanupOnRelease: options.cleanupOnRelease === true,
        artifact: authoritativeArtifact,
        statWitness: createArtifactStatWitness(fileStat),
        immutable: true,
    });
    ensureLeaseSweep();
    return cloneTypedStagedArtifact(authoritativeArtifact);
}

export function releaseManagedTempFileHandle(
    context: IDocumentsSenderIdContext,
    leaseId: unknown,
) {
    if (typeof leaseId !== 'string' || leaseId.length === 0) {
        return false;
    }
    const lease = leases.get(leaseId);
    if (!lease || lease.ownerId !== context.senderId) {
        return false;
    }
    leases.delete(leaseId);
    if (lease.cleanupOnRelease) void rm(lease.path, {force: true});
    sweepExpiredLeases();
    return true;
}

export async function resolveManagedTempFileHandle(
    context: IDocumentsSenderIdContext,
    value: unknown,
): Promise<IManagedTempFileHandle> {
    const handle = decodeManagedTempFileHandle(value);
    if (!handle) {
        throw new Error('Invalid managed binary handle');
    }
    sweepExpiredLeases();
    const lease = leases.get(handle.leaseId);
    if (!lease || 'artifact' in lease || lease.ownerId !== context.senderId || lease.path !== handle.path) {
        throw new Error('Managed binary handle lease is missing, expired, or belongs to another renderer');
    }
    const [
        inspection,
        revisionSidecar,
    ] = await Promise.all([
        fingerprintFileWithUtilityProcess(handle.path),
        readWorkingCopyRevisionSidecar(handle.path),
    ]);
    const revision = revisionSidecar?.token ?? null;
    if (inspection.bytes !== handle.size || inspection.sha256 !== handle.sha256 || revision !== handle.revision) {
        throw new Error('Managed binary handle content or revision changed after staging');
    }
    lease.expiresAt = Date.now() + MANAGED_HANDLE_TTL_MS;
    return handle;
}

export async function resolveTypedStagedArtifact(
    context: IDocumentsSenderIdContext,
    artifact: ITypedStagedArtifact,
): Promise<ITypedStagedArtifact> {
    sweepExpiredLeases();
    const lease = leases.get(artifact.leaseId);
    if (
        !lease
        || !('artifact' in lease)
        || lease.ownerId !== context.senderId
        || !isDeepStrictEqual(artifact, lease.artifact)
    ) {
        throw new Error('Staged artifact lease is missing, expired, altered, or belongs to another renderer');
    }
    let fileStat: BigIntStats;
    try {
        fileStat = await statRegularArtifact(lease.path);
    } catch {
        invalidateStagedArtifactLease(artifact.leaseId);
        throw new Error('Staged artifact content, identity, or revision changed after staging');
    }
    const statWitness = createArtifactStatWitness(fileStat);
    const identityMatches = isDeepStrictEqual(
        createArtifactFileIdentity(fileStat),
        lease.artifact.fileIdentity,
    );
    const witnessMatches = isSameArtifactStatWitness(statWitness, lease.statWitness);
    const revisionSidecar = await readWorkingCopyRevisionSidecar(lease.path);
    const revisionMatches = (revisionSidecar?.token ?? null) === lease.artifact.revision;
    if (!identityMatches || !witnessMatches || !revisionMatches) {
        invalidateStagedArtifactLease(artifact.leaseId);
        throw new Error('Staged artifact content, identity, or revision changed after staging');
    }
    if (process.platform === 'win32') {
        const inspection = await fingerprintFileWithUtilityProcess(lease.path);
        if (
            inspection.bytes !== lease.artifact.size
            || inspection.sha256 !== lease.artifact.sha256
        ) {
            invalidateStagedArtifactLease(artifact.leaseId);
            throw new Error('Staged artifact content, identity, or revision changed after staging');
        }
    }
    lease.expiresAt = Date.now() + MANAGED_HANDLE_TTL_MS;
    return cloneTypedStagedArtifact(lease.artifact);
}

export async function rebindTypedStagedArtifactPath(
    context: IDocumentsSenderIdContext,
    artifact: ITypedStagedArtifact,
    nextFilePath: unknown,
): Promise<ITypedStagedArtifact> {
    sweepExpiredLeases();
    const lease = leases.get(artifact.leaseId);
    if (
        !lease
        || !('artifact' in lease)
        || lease.ownerId !== context.senderId
        || !isDeepStrictEqual(artifact, lease.artifact)
    ) {
        throw new Error('Staged artifact lease is missing, expired, altered, or belongs to another renderer');
    }
    const nextPath = await resolveExistingReadableBinaryPath(nextFilePath, context.senderId);
    const [
        fileStat,
        revisionSidecar,
    ] = await Promise.all([
        statRegularArtifact(nextPath),
        readWorkingCopyRevisionSidecar(nextPath),
    ]);
    const statWitness = createArtifactStatWitness(fileStat);
    const witnessMatches = isSameArtifactStatWitness(statWitness, lease.statWitness);
    if (
        !isDeepStrictEqual(createArtifactFileIdentity(fileStat), lease.artifact.fileIdentity)
        || (revisionSidecar?.token ?? null) !== lease.artifact.revision
    ) {
        invalidateStagedArtifactLease(artifact.leaseId);
        throw new Error('Renamed staged artifact no longer matches its authoritative receipt');
    }
    if (!witnessMatches || process.platform === 'win32') {
        const inspection = await fingerprintFileWithUtilityProcess(nextPath);
        if (
            inspection.bytes !== lease.artifact.size
            || inspection.sha256 !== lease.artifact.sha256
        ) {
            invalidateStagedArtifactLease(artifact.leaseId);
            throw new Error('Renamed staged artifact no longer matches its authoritative receipt');
        }
    }
    const reboundArtifact = cloneTypedStagedArtifact({
        ...lease.artifact,
        path: nextPath,
    });
    lease.path = nextPath;
    lease.artifact = cloneTypedStagedArtifact(reboundArtifact);
    lease.statWitness = statWitness;
    lease.expiresAt = Date.now() + MANAGED_HANDLE_TTL_MS;
    return reboundArtifact;
}

export function clearManagedTempFileHandlesForTests() {
    leases.clear();
    if (leaseSweepTimer) {
        clearInterval(leaseSweepTimer);
        leaseSweepTimer = null;
    }
}
