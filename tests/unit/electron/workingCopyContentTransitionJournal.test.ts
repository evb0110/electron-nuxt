import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
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

interface ITransitionSidecarFixture {
    targetPath: string;
    kind?: string;
    backupPath: string | null;
}

interface ITransitionJournalFixture {sidecars: ITransitionSidecarFixture[];}

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

    it('fails closed when the transition journal cannot be read', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        const journalPath = `${path}.evb-content-transition.json`;
        await mkdir(journalPath);

        await expect(recoverWorkingCopyContentTransition(path)).rejects.toMatchObject({
            name: 'DocumentRecoveryJournalError',
            code: 'DOCUMENT_RECOVERY_JOURNAL_UNREADABLE',
            journalPath,
        });
        await expect(readdir(root)).resolves.toContain('working.pdf.evb-content-transition.json');
    });

    it('fails closed on a truncated transition journal', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        const journalPath = `${path}.evb-content-transition.json`;
        await writeFile(journalPath, '{"version":1');

        await expect(recoverWorkingCopyContentTransition(path)).rejects.toMatchObject({
            name: 'DocumentRecoveryJournalError',
            code: 'DOCUMENT_RECOVERY_JOURNAL_INVALID',
            journalPath,
        });
        await expect(readFile(journalPath, 'utf8')).resolves.toBe('{"version":1');
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

    it('snapshots only the root pointer when a prepared v4 generation sits beside a legacy manifest', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        const ocrPath = `${path}.ocr`;
        await writeFile(path, 'revision-n');
        await mkdir(ocrPath);
        await Promise.all([
            writeFile(join(ocrPath, 'manifest.json'), 'legacy-v3-manifest'),
            mkdir(join(ocrPath, 'gen-00000001')),
        ]);

        await prepareWorkingCopyContentTransition(path, requireDocumentRevisionToken('revision-n-plus-one'));
        const journal = JSON.parse(await readFile(`${path}.evb-content-transition.json`, 'utf8')) as ITransitionJournalFixture;
        expect(journal.sidecars.find(sidecar => sidecar.targetPath === ocrPath)).toMatchObject({
            kind: 'ocr-v4-root',
            backupPath: expect.any(String),
        });

        await writeFile(path, 'revision-n-plus-one');
        await rm(join(ocrPath, 'manifest.json'));
        await writeFile(join(ocrPath, 'manifest.json'), 'prepared-v4-root');
        await expect(recoverWorkingCopyContentTransition(path)).resolves.toBe(true);
        await expect(readFile(join(ocrPath, 'manifest.json'), 'utf8')).resolves.toBe('legacy-v3-manifest');
        await expect(readdir(ocrPath)).resolves.toContain('gen-00000001');
    });
});
