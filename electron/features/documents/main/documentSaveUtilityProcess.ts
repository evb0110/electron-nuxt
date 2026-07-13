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

async function inspectPdf(path: string, expectedBytes: number) {
    const fingerprint = await fingerprintFileBounded(path, expectedBytes);
    const handle = await open(path, 'r');
    try {
        const header = Buffer.alloc(5);
        await handle.read(header, 0, header.length, 0);
        if (header.toString('ascii') !== '%PDF-') throw new Error('PDF save staging file has an invalid header');
        const tailBytes = Math.min(fingerprint.bytes, 64 * 1024);
        const tail = Buffer.alloc(tailBytes);
        await handle.read(tail, 0, tailBytes, fingerprint.bytes - tailBytes);
        if (!tail.includes(Buffer.from('%%EOF'))) throw new Error('PDF save staging file has no end-of-file marker');
    } finally { await handle.close(); }
    return fingerprint;
}

async function validatePdf(path: string, validationBinary?: string, changedObjectRefs: readonly string[] = []) {
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
    await validateTargetedPdfObjects(path, validationBinary, changedObjectRefs);
}

async function atomicReplace(sourcePath: string, targetPath: string) {
    await fsyncPath(sourcePath);
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
        const inspection = request.type === 'commit'
            ? await inspectPdf(request.sourcePath, request.expectedBytes)
            : await fingerprintFileBounded(request.sourcePath, request.expectedBytes);
        if (request.type === 'commit') {
            await validatePdf(request.sourcePath, request.validationBinary, request.changedObjectRefs ?? []);
            await atomicReplace(request.sourcePath, request.targetPath);
        }
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
