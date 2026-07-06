import { randomUUID } from 'node:crypto';
import {
    mkdir,
    readFile,
    rename,
    unlink,
    writeFile,
} from 'fs/promises';
import { dirname } from 'path';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { createStaleRevisionError } from '@contracts/documentMutationErrors';
import { isRecord } from '@contracts/runtimeGuards';

export interface IWorkingCopyRevisionSidecar extends IDocumentRevisionInfo {
    sidecarVersion: 1;
    updatedAt: number;
}

export function getWorkingCopyRevisionSidecarPath(workingCopyPath: string) {
    return `${workingCopyPath}.evb-revision.json`;
}

function isPositiveTimestamp(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value > 0;
}

function isContentRevision(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 1;
}

function normalizeWorkingCopyRevisionSidecar(value: unknown): IWorkingCopyRevisionSidecar | null {
    if (!isRecord(value)) {
        return null;
    }
    if (
        value.sidecarVersion !== 1
        || value.version !== 1
        || value.authority !== 'electron-working-copy'
        || typeof value.token !== 'string'
        || value.token.length === 0
        || typeof value.documentRef !== 'string'
        || value.documentRef.length === 0
        || !isContentRevision(value.contentRevision)
        || !isPositiveTimestamp(value.mintedAt)
        || !isPositiveTimestamp(value.updatedAt)
    ) {
        return null;
    }

    const {
        contentRevision,
        mintedAt,
        updatedAt,
    } = value;

    return {
        sidecarVersion: 1,
        version: 1,
        documentRef: value.documentRef,
        authority: 'electron-working-copy',
        token: value.token,
        contentRevision,
        mintedAt,
        updatedAt,
    };
}

export async function readWorkingCopyRevisionSidecar(workingCopyPath: string) {
    try {
        const text = await readFile(getWorkingCopyRevisionSidecarPath(workingCopyPath), 'utf8');
        return normalizeWorkingCopyRevisionSidecar(JSON.parse(text));
    } catch {
        return null;
    }
}

export async function assertWorkingCopyRevisionSidecarCurrent(
    workingCopyPath: string,
    token: TDocumentRevisionToken,
): Promise<void> {
    const sidecar = await readWorkingCopyRevisionSidecar(workingCopyPath);
    if (sidecar?.token !== token) {
        throw createStaleRevisionError({
            documentRef: workingCopyPath,
            expectedRevision: token,
            actualRevision: sidecar?.token ?? null,
        });
    }
}

export async function writeWorkingCopyRevisionSidecar(
    workingCopyPath: string,
    sidecar: IWorkingCopyRevisionSidecar,
) {
    const sidecarPath = getWorkingCopyRevisionSidecarPath(workingCopyPath);
    const tempPath = `${sidecarPath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(sidecarPath), { recursive: true });
    try {
        await writeFile(tempPath, `${JSON.stringify(sidecar)}\n`, 'utf8');
        await rename(tempPath, sidecarPath);
    } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
    }
}
