import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {writeWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {recoverTwoTargetDocumentTransition} from '@electron/file-access/recoverTwoTargetDocumentTransition';

describe('two-target document transition recovery', () => {
    let root = '';

    afterEach(async () => {
        await rm(root, {
            recursive: true,
            force: true,
        });
    });

    async function prepare(publicRevision: string) {
        root = await mkdtemp(join(tmpdir(), 'evb-two-target-'));
        const workingCopyPath = join(root, 'working.pdf');
        const originalPath = join(root, 'original.pdf');
        const originalBackupPath = join(root, 'original.backup.pdf');
        const nextRevisionToken = requireDocumentRevisionToken('drt1:test:next');
        await Promise.all([
            writeFile(workingCopyPath, 'new-working-copy'),
            writeFile(originalPath, 'new-original'),
            writeFile(originalBackupPath, 'old-original'),
            writeWorkingCopyRevisionSidecar(workingCopyPath, {
                sidecarVersion: 1,
                version: 1,
                documentRef: workingCopyPath,
                authority: 'electron-working-copy',
                token: requireDocumentRevisionToken(publicRevision),
                contentRevision: 2,
                mintedAt: 2,
                updatedAt: 2,
            }),
            writeFile(`${workingCopyPath}.evb-two-target-transition.json`, JSON.stringify({
                version: 1,
                state: 'original-committed',
                workingCopyPath,
                originalPath,
                originalBackupPath,
                nextRevisionToken,
            })),
        ]);
        return {
            workingCopyPath,
            originalPath,
        };
    }

    it('restores the original when the new working-copy revision was not published', async () => {
        const {
            workingCopyPath,
            originalPath,
        } = await prepare('drt1:test:old');
        await expect(recoverTwoTargetDocumentTransition(workingCopyPath)).resolves.toBe(true);
        await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
    });

    it('keeps the new original when the exact new revision is already public', async () => {
        const {
            workingCopyPath,
            originalPath,
        } = await prepare('drt1:test:next');
        await expect(recoverTwoTargetDocumentTransition(workingCopyPath)).resolves.toBe(true);
        await expect(readFile(originalPath, 'utf8')).resolves.toBe('new-original');
    });
});
