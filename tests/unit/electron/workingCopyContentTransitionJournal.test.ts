import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {
    prepareWorkingCopyContentTransition,
    recoverWorkingCopyContentTransition,
    rollbackWorkingCopyContentTransition,
} from '@electron/file-access/workingCopyContentTransitionJournal';

describe('workingCopyContentTransitionJournal', () => {
    let root = '';

    afterEach(async () => {
        await rm(root, {
            recursive: true,
            force: true,
        });
    });

    it('recovers pre-transition bytes after a crash before revision publication', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        await writeFile(path, 'revision-n');
        await prepareWorkingCopyContentTransition(path, requireDocumentRevisionToken('revision-n-plus-one'));
        await writeFile(path, 'revision-n-plus-one');

        await expect(recoverWorkingCopyContentTransition(path)).resolves.toBe(true);
        await expect(readFile(path, 'utf8')).resolves.toBe('revision-n');
        await expect(recoverWorkingCopyContentTransition(path)).resolves.toBe(false);
    });

    it('rolls back immediately when verify or commit fails', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        await writeFile(path, 'verified');
        const journal = await prepareWorkingCopyContentTransition(
            path,
            requireDocumentRevisionToken('next-revision'),
        );
        await writeFile(path, 'unverified');
        await rollbackWorkingCopyContentTransition(journal);
        await expect(readFile(path, 'utf8')).resolves.toBe('verified');
    });

    it('recovers sidecars with the same all-old crash decision as document bytes', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        const ocrPath = `${path}.ocr`;
        const pageIdentityPath = `${path}.evb-pages.json`;
        const legacyIndexPath = `${path}.index.json`;
        const compactIndexPath = `${path}.index.evb-search-v2.bin`;
        await Promise.all([
            writeFile(path, 'revision-n'),
            mkdir(ocrPath),
            writeFile(pageIdentityPath, 'old-page-identities'),
            writeFile(legacyIndexPath, 'old-index'),
        ]);
        await writeFile(join(ocrPath, 'manifest.json'), 'old-ocr');
        await prepareWorkingCopyContentTransition(path, requireDocumentRevisionToken('revision-n-plus-one'));
        await Promise.all([
            writeFile(path, 'revision-n-plus-one'),
            rm(ocrPath, {recursive: true}),
            writeFile(pageIdentityPath, 'new-page-identities'),
            rm(legacyIndexPath),
            writeFile(compactIndexPath, 'new-compact-index'),
        ]);

        await expect(recoverWorkingCopyContentTransition(path)).resolves.toBe(true);
        await expect(readFile(path, 'utf8')).resolves.toBe('revision-n');
        await expect(readFile(join(ocrPath, 'manifest.json'), 'utf8')).resolves.toBe('old-ocr');
        await expect(readFile(pageIdentityPath, 'utf8')).resolves.toBe('old-page-identities');
        await expect(readFile(legacyIndexPath, 'utf8')).resolves.toBe('old-index');
        await expect(readFile(compactIndexPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    });
});
