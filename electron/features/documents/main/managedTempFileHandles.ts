import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import type { IManagedTempFileHandle } from '@contracts/electronApiDocuments';
import {decodeManagedTempFileHandle} from '@contracts/electronApiDocuments';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';
import { resolveExistingReadableBinaryPath } from '@electron/features/documents/main/documentFilePathResolution';
import { readWorkingCopyRevisionSidecar } from '@electron/file-access/documentRevisionSidecar';
import {fingerprintFileWithUtilityProcess} from '@electron/features/documents/main/fingerprintFileWithUtilityProcess';

const MANAGED_HANDLE_TTL_MS = 5 * 60 * 1_000;
const leases = new Map<string, {
    ownerId: number | undefined;
    path: string;
    expiresAt: number;
    cleanupOnRelease: boolean;
}>();
let leaseSweepTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (!lease || lease.ownerId !== context.senderId || lease.path !== handle.path) {
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

export function clearManagedTempFileHandlesForTests() {
    leases.clear();
    if (leaseSweepTimer) {
        clearInterval(leaseSweepTimer);
        leaseSweepTimer = null;
    }
}
