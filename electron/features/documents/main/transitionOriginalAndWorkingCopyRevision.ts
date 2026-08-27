import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import type {TDocumentRevisionChangeReason} from '@contracts/documentRevision';
import {
    copyFileAtomic,
    linkOrCopyFileDurably,
    writeFileAtomic,
} from '@electron/file-access/documentFileWriteAtomic';
import {transitionWorkingCopyContentRevision} from '@electron/file-access/documentRevisionStore';
import {withOriginalPathMutationLock} from '@electron/features/documents/main/withOriginalPathMutationLock';
import {readWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {rebindDocumentTextCatalogIfPresent} from '@electron/file-access/rebindDocumentTextCatalogIfPresent';
import {ensureWorkingCopyMaterialized} from '@electron/file-access/workingCopyMaterialization';

function journalPath(workingCopyPath: string) {
    return `${workingCopyPath}.evb-two-target-transition.json`;
}

async function writeJournal(path: string, value: unknown) {
    await writeFileAtomic(path, Buffer.from(JSON.stringify(value), 'utf8'));
}

async function measureTransitionPhase<T>(
    phase: string,
    onPhase: ((phase: string, durationMs: number) => void) | undefined,
    operation: () => Promise<T>,
): Promise<T> {
    const startedAt = performance.now();
    try {
        return await operation();
    } finally {
        onPhase?.(phase, Math.round((performance.now() - startedAt) * 10) / 10);
    }
}

export async function transitionOriginalAndWorkingCopyRevision(input: {
    workingCopyPath: string;
    originalPath: string;
    reason: TDocumentRevisionChangeReason;
    senderId?: number;
    assertOriginalCurrent?: () => Promise<boolean>;
    publishOriginal: () => Promise<void>;
    afterWorkingCopySync?: () => Promise<void>;
    onPhase?: (phase: string, durationMs: number) => void;
}) {
    await measureTransitionPhase('transition-materialize', input.onPhase, () =>
        ensureWorkingCopyMaterialized(input.workingCopyPath, {
            ...(input.senderId === undefined ? {} : {ownerWebContentsId: input.senderId}),
            reason: 'first-mutation',
        }));
    return withOriginalPathMutationLock(input.originalPath, async () => {
        if (input.assertOriginalCurrent && !await measureTransitionPhase(
            'transition-assert-original',
            input.onPhase,
            input.assertOriginalCurrent,
        )) {
            return null;
        }
        const suffix = `${process.pid}-${randomUUID()}`;
        const originalBackupPath = `${input.originalPath}.evb-transition-${suffix}.bak`;
        const previousRevision = await measureTransitionPhase(
            'transition-read-revision',
            input.onPhase,
            () => readWorkingCopyRevisionSidecar(input.workingCopyPath),
        );
        await measureTransitionPhase('transition-backup-original', input.onPhase, () =>
            linkOrCopyFileDurably(input.originalPath, originalBackupPath));
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
                    await measureTransitionPhase('transition-journal-prepared', input.onPhase, () =>
                        writeJournal(journalPath(input.workingCopyPath), record));
                    try {
                        await measureTransitionPhase('transition-publish-original', input.onPhase, input.publishOriginal);
                        await measureTransitionPhase('transition-journal-original-committed', input.onPhase, () =>
                            writeJournal(journalPath(input.workingCopyPath), {
                                ...record,
                                state: 'original-committed',
                            }));
                        await measureTransitionPhase('transition-sync-working-copy', input.onPhase, () =>
                            copyFileAtomic(input.originalPath, input.workingCopyPath, {
                                durable: false,
                                onPhase: (phase, durationMs) => input.onPhase?.(
                                    `transition-sync-working-copy-${phase}`,
                                    durationMs,
                                ),
                            }));
                        await measureTransitionPhase('transition-rebind-ocr', input.onPhase, () =>
                            rebindDocumentTextCatalogIfPresent(
                                input.workingCopyPath,
                                previousRevision?.token,
                                nextRevision.token,
                            ));
                        if (input.afterWorkingCopySync) {
                            await measureTransitionPhase(
                                'transition-after-working-copy-sync',
                                input.onPhase,
                                input.afterWorkingCopySync,
                            );
                        }
                    } catch (error) {
                        await copyFileAtomic(originalBackupPath, input.originalPath).catch(() => undefined);
                        throw error;
                    }
                },
                input.senderId,
                input.onPhase,
                'hard-link',
            );
            committed = true;
            await measureTransitionPhase('transition-cleanup', input.onPhase, () => Promise.all([
                rm(originalBackupPath, {force: true}),
                rm(journalPath(input.workingCopyPath), {force: true}),
            ]));
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
