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
    vi,
} from 'vitest';
import {
    createDeleteIdentityDelta,
    createIdentityDelta,
    createInsertIdentityDelta,
    createReorderIdentityDelta,
    commitPageIdentityDelta,
    awaitPageIdentityStoreInitialization,
    forgetPageIdentityStoreInitialization,
    schedulePageIdentityStoreInitialization,
} from '@electron/file-access/pageIdentityStore';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {writeWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {
    loadCompactSearchIndex,
    persistCompactSearchIndex,
} from '@electron/search/searchIndexSidecar';
import {loadSearchIndex} from '@electron/search/indexBuilder';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';

vi.mock('@electron/pdf/pdfPageCount', () => ({getPdfPageCount: vi.fn(async () => 3)}));

describe('page identity deltas', () => {
    let root = '';

    afterEach(async () => {
        await rm(root, {
            recursive: true,
            force: true,
        });
    });
    it('conserves every surviving page through delete and reorder', () => {
        expect(createDeleteIdentityDelta(5, [
            2,
            4,
        ]).pages).toEqual([
            {fromPageNumber: 1},
            {fromPageNumber: 3},
            {fromPageNumber: 5},
        ]);
        expect(createReorderIdentityDelta(3, [
            3,
            1,
            2,
        ]).pages).toEqual([
            {fromPageNumber: 3},
            {fromPageNumber: 1},
            {fromPageNumber: 2},
        ]);
    });

    it('mints durable identities only for inserted pages', () => {
        const delta = createInsertIdentityDelta(3, 1, 2);
        expect(delta.pages).toHaveLength(5);
        expect(delta.pages[0]).toEqual({fromPageNumber: 1});
        expect(delta.pages.slice(1, 3).every(page => 'insertedId' in page)).toBe(true);
        expect(delta.pages.slice(3)).toEqual([
            {fromPageNumber: 2},
            {fromPageNumber: 3},
        ]);
    });

    it('uses an identity delta for lossless rotate so OCR can be rebound without re-OCR', () => {
        expect(createIdentityDelta(3)).toEqual({
            previousPageCount: 3,
            pages: [
                {fromPageNumber: 1},
                {fromPageNumber: 2},
                {fromPageNumber: 3},
            ],
        });
    });

    it('does not recreate a removed working-copy directory after background initialization is cancelled', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-cancel-'));
        const path = join(root, 'working.pdf');
        await writeFile(path, '%PDF fixture');
        vi.mocked(getPdfPageCount).mockClear();
        schedulePageIdentityStoreInitialization(path, {
            version: 1,
            documentRef: path,
            authority: 'electron-working-copy',
            token: requireDocumentRevisionToken('drt1:test:cancelled'),
            contentRevision: 1,
            mintedAt: 1,
        });

        expect(getPdfPageCount).not.toHaveBeenCalled();
        const task = awaitPageIdentityStoreInitialization(path);
        const rejection = expect(task).rejects.toMatchObject({name: 'AbortError'});
        forgetPageIdentityStoreInitialization(path);
        const signal = vi.mocked(getPdfPageCount).mock.calls.at(-1)?.[1]?.signal;
        expect(signal?.aborted).toBe(true);
        await rm(root, {
            recursive: true,
            force: true,
        });
        await rejection;
        await expect(readFile(`${path}.evb-pages.json`, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('conserves page IDs, OCR, and both search indexes through one structural delta', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-'));
        const path = join(root, 'working.pdf');
        const oldToken = requireDocumentRevisionToken('drt1:test:old');
        const newToken = requireDocumentRevisionToken('drt1:test:new');
        const ocrPath = `${path}.ocr`;
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            mkdir(ocrPath),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 1,
                documentRevisionToken: oldToken,
                pageIds: [
                    'page-a',
                    'page-b',
                    'page-c',
                ],
            })),
            writeWorkingCopyRevisionSidecar(path, {
                sidecarVersion: 1,
                version: 1,
                documentRef: path,
                authority: 'electron-working-copy',
                token: oldToken,
                contentRevision: 1,
                mintedAt: 1,
                updatedAt: 1,
            }),
        ]);
        const ocrPages = [
            'one',
            'two',
            'three',
        ];
        await Promise.all(ocrPages.map((text, index) => writeFile(
            join(ocrPath, `page-${index + 1}.json`),
            JSON.stringify({
                pageNumber: index + 1,
                documentRevision: {token: oldToken},
                text,
            }),
        )));
        await writeFile(join(ocrPath, 'manifest.json'), JSON.stringify({
            version: 3,
            documentRevision: {token: oldToken},
            createdAt: 1,
            source: {pdfPath: path},
            pageCount: 3,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {
                1: {path: 'page-1.json'},
                2: {path: 'page-2.json'},
                3: {path: 'page-3.json'},
            },
        }));
        await writeFile(`${path}.index.json`, JSON.stringify({
            schemaVersion: 7,
            documentRevision: {token: oldToken},
            pdfPath: path,
            createdAt: 1,
            pageCount: 3,
            pages: ocrPages.map((text, index) => ({
                pageNumber: index + 1,
                text,
            })),
        }));
        await persistCompactSearchIndex(path, {
            documentRevision: oldToken,
            pageCount: 3,
            pages: ocrPages.map((text, index) => ({
                pageNumber: index + 1,
                text,
            })),
        });

        await commitPageIdentityDelta(path, createReorderIdentityDelta(3, [
            3,
            1,
            2,
        ]), {
            version: 1,
            documentRef: path,
            authority: 'electron-working-copy',
            token: newToken,
            contentRevision: 2,
            mintedAt: 2,
        });

        const pageIdentity = JSON.parse(await readFile(`${path}.evb-pages.json`, 'utf8')) as {pageIds: string[]};
        expect(pageIdentity.pageIds).toEqual([
            'page-c',
            'page-a',
            'page-b',
        ]);
        const ocrManifest = JSON.parse(await readFile(join(ocrPath, 'manifest.json'), 'utf8')) as {documentRevision: {token: string}};
        expect(ocrManifest.documentRevision.token).toBe(newToken);
        await expect(readFile(join(ocrPath, 'page-0001.json'), 'utf8')).resolves.toContain('three');
        await expect(loadSearchIndex(path, newToken)).resolves.toMatchObject({
            pageCount: 3,
            pages: [
                {
                    pageNumber: 1,
                    text: 'three',
                },
                {
                    pageNumber: 2,
                    text: 'one',
                },
                {
                    pageNumber: 3,
                    text: 'two',
                },
            ],
        });
        await expect(loadCompactSearchIndex(path, {documentRevision: newToken})).resolves.toMatchObject({
            pageCount: 3,
            pages: [
                {
                    pageNumber: 1,
                    text: 'three',
                },
                {
                    pageNumber: 2,
                    text: 'one',
                },
                {
                    pageNumber: 3,
                    text: 'two',
                },
            ],
        });
    });
});
