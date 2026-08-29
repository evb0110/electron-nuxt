import {
    readFile,
    rm,
} from 'node:fs/promises';
import {isRecord} from '@contracts/runtimeGuards';
import {copyFileAtomic} from '@electron/file-access/documentFileWriteAtomic';
import {readWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {
    assertPathMatchesSaveWitnessSnapshot,
    capturePathSaveWitness,
    type IOriginalPathSaveJournalSnapshot,
    OriginalPathSaveConflictError,
} from '@electron/features/documents/main/originalPathSaveBaseMatches';

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
    let publishedOriginalSnapshot: IOriginalPathSaveJournalSnapshot | undefined;
    if (value.publishedOriginalSnapshot !== undefined) {
        const snapshot = value.publishedOriginalSnapshot;
        if (
            !snapshot
            || typeof snapshot !== 'object'
            || [
                'ctimeNs',
                'deviceId',
                'inode',
                'linkCount',
                'mtimeNs',
                'sampleSha256',
                'size',
            ].some(field => typeof (snapshot as Record<string, unknown>)[field] !== 'string')
        ) {
            throw new Error('Invalid two-target document transition journal');
        }
        publishedOriginalSnapshot = snapshot as IOriginalPathSaveJournalSnapshot;
    }
    const revision = await readWorkingCopyRevisionSidecar(workingCopyPath);
    if (revision?.token !== value.nextRevisionToken) {
        if (publishedOriginalSnapshot !== undefined) {
            await assertPathMatchesSaveWitnessSnapshot(value.originalPath, publishedOriginalSnapshot);
        }
        const witness = await capturePathSaveWitness(value.originalPath);
        if (!witness) {
            throw new OriginalPathSaveConflictError();
        }
        try {
            await copyFileAtomic(value.originalBackupPath, value.originalPath, {assertDestinationCurrent: () => witness.assertCurrent()});
        } finally {
            await witness.close();
        }
    }
    await Promise.all([
        rm(value.originalBackupPath, {force: true}),
        rm(path, {force: true}),
    ]);
    return true;
}
