import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import type {TDocumentRevisionChangeReason} from '@contracts/documentRevision';
import {
    copyFileAtomic,
    writeFileAtomic,
} from '@electron/file-access/documentFileWriteAtomic';
import {transitionWorkingCopyContentRevision} from '@electron/file-access/documentRevisionStore';
import {withOriginalPathMutationLock} from '@electron/features/documents/main/withOriginalPathMutationLock';
import {readWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {rebindDocumentTextCatalogIfPresent} from '@electron/file-access/rebindDocumentTextCatalogIfPresent';

function journalPath(workingCopyPath: string) {
    return `${workingCopyPath}.evb-two-target-transition.json`;
}

async function writeJournal(path: string, value: unknown) {
    await writeFileAtomic(path, Buffer.from(JSON.stringify(value), 'utf8'));
}

export async function transitionOriginalAndWorkingCopyRevision(input: {
    workingCopyPath: string;
    originalPath: string;
    reason: TDocumentRevisionChangeReason;
    senderId?: number;
    assertOriginalCurrent?: () => Promise<boolean>;
    publishOriginal: () => Promise<void>;
    afterWorkingCopySync?: () => Promise<void>;
}) {
    return withOriginalPathMutationLock(input.originalPath, async () => {
        if (input.assertOriginalCurrent && !await input.assertOriginalCurrent()) {
            return null;
        }
        const suffix = `${process.pid}-${randomUUID()}`;
        const originalBackupPath = `${input.originalPath}.evb-transition-${suffix}.bak`;
        const previousRevision = await readWorkingCopyRevisionSidecar(input.workingCopyPath);
        await copyFileAtomic(input.originalPath, originalBackupPath);
        let committed = false;
        try {
            const event = await transitionWorkingCopyContentRevision(
                input.workingCopyPath,
                input.reason,
                async nextRevision => {
                    const record = {
                        version: 1,
                        state: 'prepared',
                        workingCopyPath: input.workingCopyPath,
                        originalPath: input.originalPath,
                        originalBackupPath,
                        nextRevisionToken: nextRevision.token,
                    } as const;
                    await writeJournal(journalPath(input.workingCopyPath), record);
                    try {
                        await input.publishOriginal();
                        await writeJournal(journalPath(input.workingCopyPath), {
                            ...record,
                            state: 'original-committed',
                        });
                        await copyFileAtomic(input.originalPath, input.workingCopyPath);
                        await rebindDocumentTextCatalogIfPresent(
                            input.workingCopyPath,
                            previousRevision?.token,
                            nextRevision.token,
                        );
                        await input.afterWorkingCopySync?.();
                    } catch (error) {
                        await copyFileAtomic(originalBackupPath, input.originalPath).catch(() => undefined);
                        throw error;
                    }
                },
                input.senderId,
            );
            committed = true;
            await Promise.all([
                rm(originalBackupPath, {force: true}),
                rm(journalPath(input.workingCopyPath), {force: true}),
            ]);
            return event;
        } finally {
            if (!committed) {
                await copyFileAtomic(originalBackupPath, input.originalPath).catch(() => undefined);
                await Promise.all([
                    rm(originalBackupPath, {force: true}),
                    rm(journalPath(input.workingCopyPath), {force: true}),
                ]);
            }
        }
    });
}
