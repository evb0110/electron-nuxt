import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
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
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {writeWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {resolveDocumentOcrPage} from '@electron/ocr/documentTextCatalog';
import {
    loadCompactSearchIndex,
    persistCompactSearchIndex,
} from '@electron/search/searchIndexSidecar';
import {loadSearchIndex} from '@electron/search/indexBuilder';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';

vi.mock('@electron/pdf/pdfPageCount', () => ({getPdfPageCount: vi.fn(async () => 3)}));

const OLD_TOKEN = requireDocumentRevisionToken('drt1:test:old');
const NEW_TOKEN = requireDocumentRevisionToken('drt1:test:new');
const OCR_PAGE_TEXTS = [
    'one',
    'two',
    'three',
];

/** Identifies every page artifact by name and inode so a rewrite cannot hide. */
async function describeOcrPageFiles(ocrPath: string) {
    const names = (await readdir(ocrPath)).filter(name => name !== 'manifest.json').sort();
    const described = await Promise.all(names.map(async name => [
        name,
        (await stat(join(ocrPath, name))).ino,
    ] as const));
    return Object.fromEntries(described);
}

describe('page identity deltas', () => {
    let root = '';

    async function publishRevisionSidecar(path: string, token: TDocumentRevisionToken) {
        await writeWorkingCopyRevisionSidecar(path, {
            sidecarVersion: 1,
            version: 1,
            documentRef: path,
            authority: 'electron-working-copy',
            token,
            contentRevision: token === OLD_TOKEN ? 1 : 2,
            mintedAt: 1,
            updatedAt: 1,
        });
    }

    function nextRevisionInfo(path: string) {
        return {
            version: 1 as const,
            documentRef: path,
            authority: 'electron-working-copy' as const,
            token: NEW_TOKEN,
            contentRevision: 2,
            mintedAt: 2,
        };
    }

    /** Seeds a three-page working copy carrying an OCR catalog and both search indexes. */
    async function seedOcrdWorkingCopy() {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-'));
        const path = join(root, 'working.pdf');
        const ocrPath = `${path}.ocr`;
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            mkdir(ocrPath),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 1,
                documentRevisionToken: OLD_TOKEN,
                pageIds: [
                    'page-a',
                    'page-b',
                    'page-c',
                ],
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
        ]);
        await Promise.all(OCR_PAGE_TEXTS.map((text, index) => writeFile(
            join(ocrPath, `page-${index + 1}.json`),
            JSON.stringify({
                rotation: 0,
                render: {
                    dpi: 300,
                    imagePx: {
                        w: 1200,
                        h: 1600,
                    },
                },
                text,
                words: [],
            }),
        )));
        await writeFile(join(ocrPath, 'manifest.json'), JSON.stringify({
            version: 3,
            documentRevision: {token: OLD_TOKEN},
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
            documentRevision: {token: OLD_TOKEN},
            pdfPath: path,
            createdAt: 1,
            pageCount: 3,
            pages: OCR_PAGE_TEXTS.map((text, index) => ({
                pageNumber: index + 1,
                text,
            })),
        }));
        await persistCompactSearchIndex(path, {
            documentRevision: OLD_TOKEN,
            pageCount: 3,
            pages: OCR_PAGE_TEXTS.map((text, index) => ({
                pageNumber: index + 1,
                text,
            })),
        });
        return {
            path,
            ocrPath,
            newToken: NEW_TOKEN,
        };
    }

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
        const {
            path,
            ocrPath,
            newToken,
        } = await seedOcrdWorkingCopy();

        await commitPageIdentityDelta(path, createReorderIdentityDelta(3, [
            3,
            1,
            2,
        ]), nextRevisionInfo(path));

        const pageIdentity = JSON.parse(await readFile(`${path}.evb-pages.json`, 'utf8')) as {pageIds: string[]};
        expect(pageIdentity.pageIds).toEqual([
            'page-c',
            'page-a',
            'page-b',
        ]);
        const ocrManifest = JSON.parse(await readFile(join(ocrPath, 'manifest.json'), 'utf8')) as {documentRevision: {token: string}};
        expect(ocrManifest.documentRevision.token).toBe(newToken);
        await publishRevisionSidecar(path, newToken);
        await expect(resolveDocumentOcrPage(path, newToken, 1)).resolves.toMatchObject({page: {text: 'three'}});
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

    it('leaves every OCR page file untouched when rotate or crop bumps the revision', async () => {
        const {
            path,
            ocrPath,
            newToken,
        } = await seedOcrdWorkingCopy();
        const before = await describeOcrPageFiles(ocrPath);

        await commitPageIdentityDelta(path, createIdentityDelta(3), nextRevisionInfo(path));

        expect(await describeOcrPageFiles(ocrPath)).toEqual(before);
        await publishRevisionSidecar(path, newToken);
        await expect(resolveDocumentOcrPage(path, newToken, 2)).resolves.toMatchObject({
            pageCount: 3,
            page: {
                pageNumber: 2,
                text: 'two',
            },
        });
    });
});
