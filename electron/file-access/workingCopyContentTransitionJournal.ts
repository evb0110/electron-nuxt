import {randomUUID} from 'node:crypto';
import {
    cp,
    readFile,
    rm,
    stat,
} from 'node:fs/promises';
import {isRecord} from '@contracts/runtimeGuards';
import {
    requireDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {readWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {
    copyFileAtomic,
    writeFileAtomic,
} from '@electron/file-access/documentFileWriteAtomic';
import {getCompactSearchIndexPath} from '@electron/search/searchIndexSidecar';

interface ITransitionSidecarBackup {
    targetPath: string;
    backupPath: string | null;
    directory: boolean;
}

interface IWorkingCopyContentTransitionJournal {
    version: 1;
    state: 'prepared';
    workingCopyPath: string;
    backupPath: string;
    nextRevisionToken: TDocumentRevisionToken;
    sidecars: ITransitionSidecarBackup[];
}

function journalPathFor(workingCopyPath: string) {
    return `${workingCopyPath}.evb-content-transition.json`;
}

async function writeJsonAtomic(path: string, value: unknown) {
    await writeFileAtomic(path, Buffer.from(JSON.stringify(value), 'utf8'));
}

function parseJournal(value: unknown): IWorkingCopyContentTransitionJournal | null {
    if (
        !isRecord(value)
        || value.version !== 1
        || value.state !== 'prepared'
        || typeof value.workingCopyPath !== 'string'
        || typeof value.backupPath !== 'string'
        || typeof value.nextRevisionToken !== 'string'
        || !Array.isArray(value.sidecars)
    ) {
        return null;
    }
    const sidecars: ITransitionSidecarBackup[] = [];
    for (const sidecar of value.sidecars) {
        if (
            !isRecord(sidecar)
            || typeof sidecar.targetPath !== 'string'
            || (sidecar.backupPath !== null && typeof sidecar.backupPath !== 'string')
            || typeof sidecar.directory !== 'boolean'
        ) {
            return null;
        }
        sidecars.push({
            targetPath: sidecar.targetPath,
            backupPath: sidecar.backupPath,
            directory: sidecar.directory,
        });
    }
    return {
        version: 1,
        state: 'prepared',
        workingCopyPath: value.workingCopyPath,
        backupPath: value.backupPath,
        nextRevisionToken: requireDocumentRevisionToken(value.nextRevisionToken),
        sidecars,
    };
}

async function backupSidecars(
    workingCopyPath: string,
    suffix: string,
    backups: ITransitionSidecarBackup[],
) {
    const targets = [
        `${workingCopyPath}.ocr`,
        `${workingCopyPath}.evb-pages.json`,
        `${workingCopyPath}.index.json`,
        getCompactSearchIndexPath(workingCopyPath),
    ];
    for (const [
        index,
        targetPath,
    ] of targets.entries()) {
        const targetStat = await stat(targetPath).catch(() => null);
        if (!targetStat) {
            backups.push({
                targetPath,
                backupPath: null,
                directory: false,
            });
            continue;
        }
        const backupPath = `${workingCopyPath}.evb-sidecar-${suffix}-${index}.bak`;
        if (targetStat.isDirectory()) await cp(targetPath, backupPath, {recursive: true});
        else await copyFileAtomic(targetPath, backupPath);
        backups.push({
            targetPath,
            backupPath,
            directory: targetStat.isDirectory(),
        });
    }
}

async function restoreSidecars(sidecars: readonly ITransitionSidecarBackup[]) {
    await Promise.all(sidecars.map(async sidecar => {
        await rm(sidecar.targetPath, {
            recursive: true,
            force: true,
        });
        if (!sidecar.backupPath) {
            return;
        }
        if (sidecar.directory) await cp(sidecar.backupPath, sidecar.targetPath, {recursive: true});
        else await copyFileAtomic(sidecar.backupPath, sidecar.targetPath);
    }));
}

async function removeSidecarBackups(sidecars: readonly ITransitionSidecarBackup[]) {
    await Promise.all(sidecars.flatMap(sidecar => sidecar.backupPath
        ? [rm(sidecar.backupPath, {
            recursive: true,
            force: true,
        })]
        : []));
}

export async function prepareWorkingCopyContentTransition(
    workingCopyPath: string,
    nextRevisionToken: TDocumentRevisionToken,
) {
    await recoverWorkingCopyContentTransition(workingCopyPath);
    const suffix = `${process.pid}-${randomUUID()}`;
    const backupPath = `${workingCopyPath}.evb-content-${suffix}.bak`;
    await copyFileAtomic(workingCopyPath, backupPath);
    const sidecars: ITransitionSidecarBackup[] = [];
    try {
        await backupSidecars(workingCopyPath, suffix, sidecars);
    } catch (error) {
        await Promise.all([
            rm(backupPath, {force: true}),
            removeSidecarBackups(sidecars),
        ]);
        throw error;
    }
    const journal: IWorkingCopyContentTransitionJournal = {
        version: 1,
        state: 'prepared',
        workingCopyPath,
        backupPath,
        nextRevisionToken,
        sidecars,
    };
    await writeJsonAtomic(journalPathFor(workingCopyPath), journal);
    return journal;
}

export async function rollbackWorkingCopyContentTransition(
    journal: IWorkingCopyContentTransitionJournal,
) {
    await copyFileAtomic(journal.backupPath, journal.workingCopyPath);
    await restoreSidecars(journal.sidecars);
    await completeWorkingCopyContentTransition(journal);
}

export async function completeWorkingCopyContentTransition(
    journal: IWorkingCopyContentTransitionJournal,
) {
    await Promise.all([
        rm(journal.backupPath, {force: true}),
        rm(journalPathFor(journal.workingCopyPath), {force: true}),
        removeSidecarBackups(journal.sidecars),
    ]);
}

/**
 * A prepared transition is committed only when its exact revision token is
 * already public. Otherwise the old bytes win. This closes both crash windows:
 * content-before-revision and revision-before-journal-cleanup.
 */
export async function recoverWorkingCopyContentTransition(workingCopyPath: string) {
    const journalPath = journalPathFor(workingCopyPath);
    const value: unknown = await readFile(journalPath, 'utf8')
        .then(raw => JSON.parse(raw) as unknown)
        .catch(() => null);
    const journal = parseJournal(value);
    if (!journal) {
        return false;
    }
    if (journal.workingCopyPath !== workingCopyPath) {
        throw new Error('Working-copy content transition journal targets another document');
    }
    const revision = await readWorkingCopyRevisionSidecar(workingCopyPath);
    if (revision?.token !== journal.nextRevisionToken) {
        await copyFileAtomic(journal.backupPath, workingCopyPath);
        await restoreSidecars(journal.sidecars);
    }
    await completeWorkingCopyContentTransition(journal);
    return true;
}
