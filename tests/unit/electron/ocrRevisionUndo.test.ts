import {
    access,
    mkdtemp,
    mkdir,
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
    vi,
} from 'vitest';

const revisionEvent = {
    documentRevision: 12,
    previousDocumentRevision: 11,
    reason: 'ocr-apply',
};

vi.mock('@electron/file-access/workingCopyMutationQueue', () => ({enqueueWorkingCopyMutation: vi.fn(async (
    _workingCopyPath: string,
    mutation: () => Promise<unknown>,
) => mutation())}));

const revisionMocks = vi.hoisted(() => ({assertCurrent: vi.fn()}));

vi.mock('@electron/file-access/documentRevisionStore', () => ({
    assertWorkingCopyRevisionCurrent: revisionMocks.assertCurrent,
    transitionWorkingCopyContentRevision: vi.fn(async (
        _workingCopyPath: string,
        _reason: string,
        mutation: () => Promise<void>,
    ) => {
        await mutation();
        return revisionEvent;
    }),
}));

vi.mock('@electron/file-access/documentFileWriteAtomic', async () => {
    const {copyFile} = await import('node:fs/promises');
    return {copyFileAtomic: vi.fn(copyFile)};
});

const {undoOcrRevisionTransition} = await import('@electron/ocr/undoOcrRevisionTransition');

let root: string | null = null;

afterEach(async () => {
    if (root) await rm(root, {
        recursive: true,
        force: true,
    });
    root = null;
});

async function expectMissing(path: string) {
    await expect(access(path)).rejects.toMatchObject({code: 'ENOENT'});
}

describe('OCR revision transition undo', () => {
    it('atomically restores exact pre-OCR PDF/catalog bytes and rejects replay', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-ocr-transition-undo-'));
        const workingCopyPath = join(root, 'working.pdf');
        const catalogPath = `${workingCopyPath}.ocr`;
        const undoPdfPath = join(root, 'undo.pdf');
        const undoCatalogPath = join(root, 'undo-catalog');
        const journalPath = `${workingCopyPath}.ocr-transition.json`;

        await writeFile(workingCopyPath, 'ocr-applied-pdf');
        await mkdir(catalogPath, {recursive: true});
        await writeFile(join(catalogPath, 'manifest.json'), 'ocr-applied-catalog');
        await writeFile(undoPdfPath, 'exact-pre-ocr-pdf');
        await mkdir(undoCatalogPath, {recursive: true});
        await writeFile(join(undoCatalogPath, 'manifest.json'), 'exact-pre-ocr-catalog');
        await writeFile(journalPath, JSON.stringify({
            version: 1,
            transitionId: 'transition-undo-1',
            state: 'committed',
            workingCopyPath,
            targetDocumentRevisionToken: 'ocr-revision',
            undoPdfPath,
            undoCatalogPath,
        }));

        await expect(undoOcrRevisionTransition(
            workingCopyPath,
            'transition-undo-1',
            42,
        )).resolves.toEqual(revisionEvent);
        expect(revisionMocks.assertCurrent).toHaveBeenCalledWith(workingCopyPath, 'ocr-revision');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('exact-pre-ocr-pdf');
        await expect(readFile(join(catalogPath, 'manifest.json'), 'utf8'))
            .resolves.toBe('exact-pre-ocr-catalog');
        await Promise.all([
            expectMissing(undoPdfPath),
            expectMissing(undoCatalogPath),
            expectMissing(journalPath),
        ]);

        await expect(undoOcrRevisionTransition(workingCopyPath, 'transition-undo-1'))
            .rejects.toMatchObject({code: 'ENOENT'});
    });
});
