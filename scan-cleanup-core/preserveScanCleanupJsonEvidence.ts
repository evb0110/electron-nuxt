import {
    copyFile,
    mkdir,
    readdir,
    readFile,
    writeFile,
} from 'node:fs/promises';
import {
    basename,
    isAbsolute,
    join,
} from 'node:path';
import type {TScanCleanupLog} from '@scan-cleanup-core/types';

const SCAN_CLEANUP_EVIDENCE_DIR_ENV = 'EVB_SCAN_CLEANUP_EVIDENCE_DIR';

export async function preserveScanCleanupJsonEvidence(
    scratch: string,
    log: TScanCleanupLog,
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
        .filter(entry => entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')))
        .map(entry => entry.name);
    await mkdir(evidenceDir, {recursive: true});
    await Promise.all(jsonFiles.map(fileName => copyFile(
        join(scratch, fileName),
        join(evidenceDir, fileName),
    )));
    const reportFileName = 'scan-cleanup-representation-report.json';
    if (jsonFiles.includes(reportFileName)) {
        const reportPath = join(evidenceDir, reportFileName);
        const report = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
        for (const field of [
            'outputMappingsSidecarPath',
            'pagesSidecarPath',
        ]) {
            const value = report[field];
            if (typeof value !== 'string') continue;
            const fileName = basename(value);
            if (jsonFiles.includes(fileName)) {
                report[field] = join(evidenceDir, fileName);
            }
        }
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    await writeFile(
        join(evidenceDir, 'scan-cleanup-evidence-manifest.json'),
        `${JSON.stringify({
            schemaVersion: 1,
            files: jsonFiles,
        }, null, 2)}\n`,
    );
    log('debug', `Preserved ${String(jsonFiles.length)} scan cleanup JSON evidence files`);
}
