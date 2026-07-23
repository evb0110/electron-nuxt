import {randomUUID} from 'node:crypto';
import {
    rm,
    stat,
} from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import type { IManagedTempFileHandle } from '@contracts/electronApiDocuments';
import {decodeManagedTempFileHandle} from '@contracts/electronApiDocuments';
import type {
    IStagedArtifactValidations,
    ITypedStagedArtifact,
    TArtifactFileIdentity,
} from '@contracts/stagedArtifacts';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';
import { resolveExistingReadableBinaryPath } from '@electron/features/documents/main/documentFilePathResolution';
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
    statWitness: {
        size: bigint;
        mtimeNs: bigint;
        ctimeNs: bigint;
    };
    immutable: true;
}

const leases = new Map<string, IMainManagedTempFileLease | IMainStagedArtifactLease>();
let leaseSweepTimer: ReturnType<typeof setTimeout> | null = null;

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
    const path = await resolveExistingReadableBinaryPath(filePath, context.senderId);
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
    options: {cleanupOnRelease?: boolean} = {},
): Promise<ITypedStagedArtifact> {
    const path = await resolveExistingReadableBinaryPath(filePath, context.senderId);
    const [
        inspection,
        revisionSidecar,
        fileStat,
    ] = await Promise.all([
        fingerprintFileWithUtilityProcess(path),
        readWorkingCopyRevisionSidecar(path),
        stat(path, {bigint: true}),
    ]);
    const leaseId = randomUUID();
    const artifact: ITypedStagedArtifact = {
        receiptVersion: 1,
        artifactKind: 'pdf',
        path,
        size: inspection.bytes,
        sha256: inspection.sha256,
        fileIdentity: createArtifactFileIdentity(fileStat),
        validations,
        leaseId,
        revision: revisionSidecar?.token ?? null,
    };
    leases.set(leaseId, {
        ownerId: context.senderId,
        path,
        expiresAt: Date.now() + MANAGED_HANDLE_TTL_MS,
        cleanupOnRelease: options.cleanupOnRelease === true,
        artifact,
        statWitness: {
            size: fileStat.size,
            mtimeNs: fileStat.mtimeNs,
            ctimeNs: fileStat.ctimeNs,
        },
        immutable: true,
    });
    ensureLeaseSweep();
    return artifact;
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
    const [
        inspection,
        revisionSidecar,
        fileStat,
    ] = await Promise.all([
        fingerprintFileWithUtilityProcess(artifact.path),
        readWorkingCopyRevisionSidecar(artifact.path),
        stat(artifact.path, {bigint: true}),
    ]);
    const revision = revisionSidecar?.token ?? null;
    if (
        inspection.bytes !== artifact.size
        || inspection.sha256 !== artifact.sha256
        || revision !== artifact.revision
        || !isDeepStrictEqual(createArtifactFileIdentity(fileStat), artifact.fileIdentity)
    ) {
        throw new Error('Staged artifact content, identity, or revision changed after staging');
    }
    lease.statWitness = {
        size: fileStat.size,
        mtimeNs: fileStat.mtimeNs,
        ctimeNs: fileStat.ctimeNs,
    };
    lease.expiresAt = Date.now() + MANAGED_HANDLE_TTL_MS;
    return lease.artifact;
}

export function clearManagedTempFileHandlesForTests() {
    leases.clear();
    if (leaseSweepTimer) {
        clearInterval(leaseSweepTimer);
        leaseSweepTimer = null;
    }
}
