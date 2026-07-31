import {
    copyFile,
    mkdir,
    readdir,
} from 'node:fs/promises';
import {
    isAbsolute,
    join,
} from 'node:path';
import type {TWorkerLog} from '@electron/ocr/worker/types';

const SCAN_CLEANUP_EVIDENCE_DIR_ENV = 'EVB_SCAN_CLEANUP_EVIDENCE_DIR';

export async function preserveScanCleanupJsonEvidence(
    scratch: string,
    log: TWorkerLog,
) {
    const evidenceDir = process.env[SCAN_CLEANUP_EVIDENCE_DIR_ENV]?.trim();
    if (!evidenceDir) {
        return;
    }
    if (!isAbsolute(evidenceDir)) {
        log('warn', `Ignoring ${SCAN_CLEANUP_EVIDENCE_DIR_ENV} because it is not absolute`);
        return;
    }

    const entries = await readdir(scratch, {withFileTypes: true});
    const jsonFiles = entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => entry.name);
    await mkdir(evidenceDir, {recursive: true});
    await Promise.all(jsonFiles.map(fileName => copyFile(
        join(scratch, fileName),
        join(evidenceDir, fileName),
    )));
    log('debug', `Preserved ${String(jsonFiles.length)} scan cleanup JSON evidence files`);
}
