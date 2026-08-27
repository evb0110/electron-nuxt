import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as FsPromises from 'node:fs/promises';
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
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {
    prepareWorkingCopyContentTransition,
    rollbackWorkingCopyContentTransition,
} from '@electron/file-access/workingCopyContentTransitionJournal';

const mocks = vi.hoisted(() => ({cp: vi.fn()}));

vi.mock('node:fs/promises', async () => ({
    ...(await vi.importActual<typeof FsPromises>('node:fs/promises')),
    cp: mocks.cp,
}));

describe('workingCopyContentTransitionJournal v4 roots', () => {
    let root = '';

    afterEach(async () => {
        await rm(root, {
            recursive: true,
            force: true,
        });
        mocks.cp.mockReset();
    });

    it('rolls back a million-page root pointer without recursively copying the catalog', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-v4-'));
        const workingCopyPath = join(root, 'working.pdf');
        const catalogPath = `${workingCopyPath}.ocr`;
        await writeFile(workingCopyPath, 'revision-n');
        await mkdir(catalogPath);
        await writeFile(join(catalogPath, 'manifest.json'), JSON.stringify({
            version: 4,
            catalogId: '00000000-0000-4000-8000-000000000001',
            source: {pdfPath: workingCopyPath},
            documentRevision: {token: requireDocumentRevisionToken('revision-n')},
            pageCount: 1_000_001,
            shardSize: 256,
            generation: 1,
            publishedAt: '2026-08-27T00:00:00.000Z',
        }));
        await mkdir(join(catalogPath, 'gen-00000001'));

        mocks.cp.mockImplementation(() => {
            throw new Error('recursive catalog copy forbidden');
        });

        const journal = await prepareWorkingCopyContentTransition(
            workingCopyPath,
            requireDocumentRevisionToken('revision-n-plus-one'),
        );
        await writeFile(workingCopyPath, 'revision-n-plus-one');
        await writeFile(join(catalogPath, 'manifest.json'), 'new-v4-root');

        await expect(rollbackWorkingCopyContentTransition(journal)).resolves.toBeUndefined();
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('revision-n');
        await expect(readFile(join(catalogPath, 'manifest.json'), 'utf8'))
            .resolves.toContain('"pageCount":1000001');
        await expect(readdir(catalogPath)).resolves.toContain('gen-00000001');
    });
});
