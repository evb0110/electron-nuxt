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
} from '@electron/file-access/originalPathSaveWitness';

function journalPath(workingCopyPath: string) {
    return `${workingCopyPath}.evb-two-target-transition.json`;
}

function parseJournalSnapshot(value: unknown) {
    if (value === undefined) {
        return undefined;
    }
    if (
        !value
        || typeof value !== 'object'
        || [
            'ctimeNs',
            'deviceId',
            'inode',
            'linkCount',
            'mtimeNs',
            'sampleSha256',
            'size',
        ].some(name => typeof (value as Record<string, unknown>)[name] !== 'string')
    ) {
        throw new Error('Invalid two-target document transition journal');
    }
    return value as IOriginalPathSaveJournalSnapshot;
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
    const preparedOriginalSnapshot = parseJournalSnapshot(value.preparedOriginalSnapshot);
    const publishedOriginalSnapshot = parseJournalSnapshot(value.publishedOriginalSnapshot);
    const revision = await readWorkingCopyRevisionSidecar(workingCopyPath);
    if (revision?.token !== value.nextRevisionToken) {
        const expectedOriginalSnapshot = value.state === 'prepared'
            ? preparedOriginalSnapshot
            : publishedOriginalSnapshot;
        if (expectedOriginalSnapshot !== undefined) {
            await assertPathMatchesSaveWitnessSnapshot(value.originalPath, expectedOriginalSnapshot);
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
