import {
    cp,
    readFile,
    rm,
    unlink,
    writeFile,
} from 'node:fs/promises';
import {copyFileAtomic} from '@electron/features/documents/public/index';
import {isRecord} from '@contracts/runtimeGuards';
import {readWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';

function parseJson(raw: string): unknown {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
}

/** Recovers a crash-interrupted OCR apply to the pre-transition bytes/catalog. */
export async function recoverPreparedOcrRevisionTransition(workingCopyPath: string) {
    const journalPath = `${workingCopyPath}.ocr-transition.json`;
    const journal: unknown = await readFile(journalPath, 'utf8')
        .then(parseJson)
        .catch(() => null);
    if (!isRecord(journal) || journal.version !== 1 || journal.state !== 'prepared') {
        return false;
    }
    if (
        typeof journal.workingCopyPath !== 'string'
        || journal.workingCopyPath !== workingCopyPath
        || typeof journal.transitionId !== 'string'
        || typeof journal.pdfBackupPath !== 'string'
        || typeof journal.catalogBackupPath !== 'string'
    ) {
        throw new Error('Invalid OCR revision transition recovery journal');
    }
    const catalogBackupExisted = journal.catalogBackupExisted !== false;

    const currentRevision = await readWorkingCopyRevisionSidecar(workingCopyPath);
    if (
        typeof journal.targetDocumentRevisionToken === 'string'
        && currentRevision?.token === journal.targetDocumentRevisionToken
    ) {
        await writeFile(journalPath, JSON.stringify({
            version: 1,
            transitionId: journal.transitionId,
            state: 'committed',
            workingCopyPath,
            targetDocumentRevisionToken: journal.targetDocumentRevisionToken,
            undoPdfPath: journal.pdfBackupPath,
            undoCatalogPath: journal.catalogBackupPath,
            undoCatalogExisted: catalogBackupExisted,
            committedAt: Date.now(),
        }), 'utf8');
        return true;
    }

    await copyFileAtomic(journal.pdfBackupPath, workingCopyPath);
    await rm(`${workingCopyPath}.ocr`, {
        recursive: true,
        force: true,
    });
    if (catalogBackupExisted) {
        await cp(journal.catalogBackupPath, `${workingCopyPath}.ocr`, {recursive: true});
    }
    await Promise.all([
        unlink(journal.pdfBackupPath).catch(() => undefined),
        rm(journal.catalogBackupPath, {
            recursive: true,
            force: true,
        }).catch(() => undefined),
        unlink(journalPath).catch(() => undefined),
    ]);
    return true;
}
