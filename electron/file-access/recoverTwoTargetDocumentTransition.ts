import {
    readFile,
    rm,
} from 'node:fs/promises';
import {isRecord} from '@contracts/runtimeGuards';
import {copyFileAtomic} from '@electron/file-access/documentFileWriteAtomic';
import {readWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';

function journalPath(workingCopyPath: string) {
    return `${workingCopyPath}.evb-two-target-transition.json`;
}

export async function recoverTwoTargetDocumentTransition(workingCopyPath: string) {
    const path = journalPath(workingCopyPath);
    const value: unknown = await readFile(path, 'utf8')
        .then(raw => JSON.parse(raw) as unknown)
        .catch(() => null);
    if (!isRecord(value)) {
        return false;
    }
    if (
        value.version !== 1
        || (value.state !== 'prepared' && value.state !== 'original-committed')
        || value.workingCopyPath !== workingCopyPath
        || typeof value.originalPath !== 'string'
        || typeof value.originalBackupPath !== 'string'
        || typeof value.nextRevisionToken !== 'string'
    ) {
        throw new Error('Invalid two-target document transition journal');
    }
    const revision = await readWorkingCopyRevisionSidecar(workingCopyPath);
    if (revision?.token !== value.nextRevisionToken) {
        await copyFileAtomic(value.originalBackupPath, value.originalPath);
    }
    await Promise.all([
        rm(value.originalBackupPath, {force: true}),
        rm(path, {force: true}),
    ]);
    return true;
}
