import {randomBytes} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {
    copyFile,
    open,
    rename,
    stat,
    unlink,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
    decodeDocumentSaveUtilityRequest,
    getDocumentSaveUtilityReusePlan,
    type TDocumentSaveUtilityResult,
} from '@electron/features/documents/main/documentSaveUtilityProtocol';
import {fingerprintFileBounded} from '@electron/features/documents/main/fingerprintFileBounded';
import {validateTargetedPdfObjects} from '@electron/features/documents/main/validateTargetedPdfObjects';
import {syncFileHandleForDurability} from '@electron/utils/syncFileHandleForDurability';

const execFileAsync = promisify(execFile);
const {parentPort} = process;

if (!parentPort) {
    throw new Error('Document save utility started without a parent port');
}

async function exists(path: string) {
    try { await stat(path); return true; } catch { return false; }
}

async function fsyncPath(path: string) {
    const handle = await open(path, 'r');
    try { await syncFileHandleForDurability(handle); } finally { await handle.close(); }
}

async function fsyncDirectory(path: string) {
    if (process.platform === 'win32') {
        return;
    }
    const handle = await open(dirname(path), fsConstants.O_RDONLY).catch(() => null);
    try { await handle?.sync().catch(() => undefined); } finally { await handle?.close().catch(() => undefined); }
}

async function inspectPdf(
    path: string,
    expectedBytes: number,
    options: {
        sha256?: string;
        tailCheck?: boolean;
    } = {},
) {
    const fingerprint = options.sha256 === undefined
        ? await fingerprintFileBounded(path, expectedBytes)
        : {
            bytes: expectedBytes,
            sha256: options.sha256,
        };
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size !== expectedBytes) {
        throw new Error('PDF save staging file size changed after receipt validation');
    }
    const handle = await open(path, 'r');
    try {
        const header = Buffer.alloc(5);
        await handle.read(header, 0, header.length, 0);
        if (header.toString('ascii') !== '%PDF-') throw new Error('PDF save staging file has an invalid header');
        if (options.tailCheck !== true) {
            const tailBytes = Math.min(fingerprint.bytes, 64 * 1024);
            const tail = Buffer.alloc(tailBytes);
            await handle.read(tail, 0, tailBytes, fingerprint.bytes - tailBytes);
            if (!tail.includes(Buffer.from('%%EOF'))) throw new Error('PDF save staging file has no end-of-file marker');
        }
    } finally { await handle.close(); }
    return fingerprint;
}

async function validatePdf(path: string, validationBinary?: string) {
    if (!validationBinary) {
        return;
    }
    try {
        await execFileAsync(validationBinary, [
            '--check',
            path,
        ], {
            timeout: 5 * 60_000,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
        });
    } catch (error) {
        const exitCode: unknown = (error as {code?: unknown}).code;
        if (exitCode !== 3 && exitCode !== '3') {
            throw new Error(`PDF save staging file failed qpdf validation: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

async function atomicReplace(
    sourcePath: string,
    targetPath: string,
    options: {fileSync?: boolean} = {},
) {
    if (options.fileSync !== true) {
        await fsyncPath(sourcePath);
    }
    if (process.env.EVB_DOCUMENT_RECOVERY_COPY === '1' && await exists(targetPath)) {
        const recoveryTemp = `${targetPath}.evb-recovery.tmp`;
        await copyFile(targetPath, recoveryTemp);
        await fsyncPath(recoveryTemp);
        await rename(recoveryTemp, `${targetPath}.evb-recovery`);
    }
    if (process.platform !== 'win32') {
        await rename(sourcePath, targetPath);
        await fsyncDirectory(targetPath);
        return;
    }
    const backup = `${targetPath}.bak-${randomBytes(8).toString('hex')}`;
    let backedUp = false;
    try { await rename(targetPath, backup); backedUp = true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try { await rename(sourcePath, targetPath); } catch (error) {
        if (backedUp) await rename(backup, targetPath);
        throw error;
    }
    await fsyncDirectory(targetPath);
    if (backedUp) await unlink(backup).catch(() => undefined);
}

parentPort.once('message', (event) => {
    void (async () => {
        const request = decodeDocumentSaveUtilityRequest(event.data);
        if (!request) throw new Error('Invalid document save utility request');
        if (request.type === 'inspect') {
            const inspection = await fingerprintFileBounded(request.sourcePath, request.expectedBytes);
            const result: TDocumentSaveUtilityResult = {
                type: 'result',
                ok: true,
                ...inspection,
            };
            parentPort.postMessage(result);
            return;
        }
        const reuse = getDocumentSaveUtilityReusePlan(request);
        let receiptSha256: string | undefined;
        if (reuse.fingerprint) {
            if (request.stagedArtifact === undefined) {
                throw new Error('Document save receipt reuse was enabled without an artifact');
            }
            receiptSha256 = request.stagedArtifact.sha256;
        }
        const inspection = await inspectPdf(request.sourcePath, request.expectedBytes, {
            ...(receiptSha256 === undefined ? {} : {sha256: receiptSha256}),
            ...(reuse.tailCheck ? {tailCheck: true} : {}),
        });
        if (!reuse.qpdfCheck) {
            await validatePdf(request.sourcePath, request.validationBinary);
        }
        const changedObjectRefs = request.changedObjectRefs ?? [];
        if (
            changedObjectRefs.length > 0
            && !reuse.changedObjectRefsCheck
            && request.validationBinary
        ) {
            await validateTargetedPdfObjects(
                request.sourcePath,
                request.validationBinary,
                changedObjectRefs,
            );
        }
        await atomicReplace(request.sourcePath, request.targetPath, {...(reuse.fileSync ? {fileSync: true} : {})});
        const result: TDocumentSaveUtilityResult = {
            type: 'result',
            ok: true,
            ...inspection,
        };
        parentPort.postMessage(result);
    })().catch((error: unknown) => {
        const result: TDocumentSaveUtilityResult = {
            type: 'result',
            ok: false,
            error: error instanceof Error ? error.message : 'Document save utility failed',
        };
        parentPort.postMessage(result);
    });
});
