import {
    cp,
    readFile,
    rm,
    unlink,
} from 'node:fs/promises';
import {isRecord} from '@contracts/runtimeGuards';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {copyFileAtomic} from '@electron/features/documents/public/index';
import {enqueueWorkingCopyMutation} from '@electron/file-access/workingCopyMutationQueue';
import {
    assertWorkingCopyRevisionCurrent,
    transitionWorkingCopyContentRevision,
} from '@electron/file-access/documentRevisionStore';

function parseJson(raw: string): unknown {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
}

/** Restores the exact pre-OCR bytes/catalog retained by a committed transition. */
export async function undoOcrRevisionTransition(
    workingCopyPath: string,
    transitionId: string,
    senderId?: number,
) {
    return enqueueWorkingCopyMutation(workingCopyPath, async () => {
        const journalPath = `${workingCopyPath}.ocr-transition.json`;
        const journal: unknown = await readFile(journalPath, 'utf8').then(parseJson);
        const targetDocumentRevisionToken = isRecord(journal)
            ? parseDocumentRevisionToken(journal.targetDocumentRevisionToken)
            : null;
        if (
            !isRecord(journal)
            || journal.version !== 1
            || journal.state !== 'committed'
            || journal.transitionId !== transitionId
            || targetDocumentRevisionToken === null
            || typeof journal.undoPdfPath !== 'string'
            || typeof journal.undoCatalogPath !== 'string'
        ) {
            throw new Error('OCR undo artifact is missing or does not match the transition');
        }
        const undoPdfPath = journal.undoPdfPath;
        const undoCatalogPath = journal.undoCatalogPath;
        const undoCatalogExisted = journal.undoCatalogExisted !== false;
        await assertWorkingCopyRevisionCurrent(
            workingCopyPath,
            targetDocumentRevisionToken,
        );
        const event = await transitionWorkingCopyContentRevision(
            workingCopyPath,
            'ocr-apply',
            async () => {
                await copyFileAtomic(undoPdfPath, workingCopyPath);
                await rm(`${workingCopyPath}.ocr`, {
                    recursive: true,
                    force: true,
                });
                if (undoCatalogExisted) {
                    await cp(undoCatalogPath, `${workingCopyPath}.ocr`, {recursive: true});
                }
            },
            senderId,
        );
        await Promise.all([
            unlink(undoPdfPath).catch(() => undefined),
            rm(undoCatalogPath, {
                recursive: true,
                force: true,
            }).catch(() => undefined),
            unlink(journalPath).catch(() => undefined),
        ]);
        return event;
    });
}
