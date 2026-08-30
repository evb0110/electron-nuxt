import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
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
    createDeleteRangeIdentityDelta,
    createDeleteRangesIdentityDelta,
    createIdentityDelta,
    createInsertIdentityDelta,
    createMoveIdentityDelta,
    createPageMoveRangesIdentityDelta,
    createReorderIdentityDelta,
    createRotateIdentityDelta,
    commitPageIdentityDelta,
    derivePageIdentity,
    readPageIdentity,
    awaitPageIdentityStoreInitialization,
    forgetPageIdentityStoreInitialization,
    schedulePageIdentityStoreInitialization,
} from '@electron/file-access/pageIdentityStore';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {writeWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {resolveDocumentOcrPage} from '@electron/ocr/documentTextCatalog';
import * as ocrIndexWriter from '@electron/ocr/worker/indexWriterV4';
import {
    loadCompactSearchIndex,
    persistCompactSearchIndexStreaming,
    persistCompactSearchIndex,
} from '@electron/search/searchIndexSidecar';
import {loadSearchIndex} from '@electron/search/indexBuilder';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';
import * as searchIndexBuilder from '@electron/search/indexBuilder';
import * as searchIndexSidecar from '@electron/search/searchIndexSidecar';

vi.mock('@electron/pdf/pdfPageCount', () => ({getPdfPageCount: vi.fn(async () => 3)}));

const fsGuards = vi.hoisted(() => ({
    forbidCopy: false,
    forbidRead: false,
}));

vi.mock('node:fs/promises', async importActual => {
    const actual = await importActual<typeof FsPromises>();
    const readFile = ((...args: Parameters<typeof actual.readFile>) => {
        if (fsGuards.forbidRead) {
            return Promise.reject(new Error('whole-manifest read is forbidden'));
        }
        return actual.readFile(...args);
    }) as typeof actual.readFile;
    const copyFile = ((...args: Parameters<typeof actual.copyFile>) => {
        if (fsGuards.forbidCopy) {
            return Promise.reject(new Error('whole-manifest copy is forbidden'));
        }
        return actual.copyFile(...args);
    }) as typeof actual.copyFile;
    return {
        ...actual,
        default: {
            ...actual,
            readFile,
            copyFile,
        },
        readFile,
        copyFile,
    };
});

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
                1: {
                    path: 'page-1.json',
                    generation: 'ocr-run-one',
                },
                2: {
                    path: 'page-2.json',
                    generation: 'ocr-run-one',
                },
                3: {
                    path: 'page-3.json',
                    generation: 'ocr-run-two',
                },
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
        vi.restoreAllMocks();
        fsGuards.forbidCopy = false;
        fsGuards.forbidRead = false;
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
        if (delta.pages === undefined) {
            throw new Error('Expected the small insert delta to use page entries');
        }
        const {pages} = delta;
        expect(pages).toHaveLength(5);
        expect(pages[0]).toEqual({fromPageNumber: 1});
        expect(pages.slice(1, 3).every(page => 'insertedId' in page)).toBe(true);
        expect(pages.slice(3)).toEqual([
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

    it('keeps million-page rotate and move deltas bounded', () => {
        const pageCount = 1_000_000;
        const rotate = createRotateIdentityDelta(pageCount, [500_000]);
        if (!('ranges' in rotate)) {
            throw new Error('Expected the large rotate delta to use ranges');
        }
        const {ranges: rotateRanges} = rotate;
        expect(rotate.nextPageCount).toBe(pageCount);
        expect(rotateRanges).toEqual([
            {
                kind: 'retain',
                fromPageNumber: 1,
                toPageNumber: 1,
                count: 500_000,
            },
            {
                kind: 'touch',
                toPageNumber: 500_000,
                count: 1,
                reason: 'rotate',
            },
            {
                kind: 'retain',
                fromPageNumber: 500_001,
                toPageNumber: 500_001,
                count: 500_000,
            },
        ]);

        const moveToEnd = createMoveIdentityDelta(pageCount, 1, pageCount);
        expect(moveToEnd.pages).toBeUndefined();
        expect(moveToEnd.ranges).toEqual([
            {
                kind: 'move',
                fromPageNumber: 2,
                toPageNumber: 1,
                count: pageCount - 1,
            },
            {
                kind: 'move',
                fromPageNumber: 1,
                toPageNumber: pageCount,
                count: 1,
            },
        ]);

        const moveToFront = createMoveIdentityDelta(pageCount, 900_000, 1);
        expect(moveToFront.pages).toBeUndefined();
        expect(moveToFront.ranges).toEqual([
            {
                kind: 'move',
                fromPageNumber: 900_000,
                toPageNumber: 1,
                count: 1,
            },
            {
                kind: 'move',
                fromPageNumber: 1,
                toPageNumber: 2,
                count: 899_999,
            },
            {
                kind: 'retain',
                fromPageNumber: 900_001,
                toPageNumber: 900_001,
                count: 100_000,
            },
        ]);

        const deleteRange = createDeleteRangeIdentityDelta(pageCount, 900_000, 1);
        expect(deleteRange.pages).toBeUndefined();
        expect(deleteRange.nextPageCount).toBe(pageCount - 1);
        expect(deleteRange.ranges).toEqual([
            {
                kind: 'retain',
                fromPageNumber: 1,
                toPageNumber: 1,
                count: 899_999,
            },
            {
                kind: 'delete',
                fromPageNumber: 900_000,
                count: 1,
            },
            {
                kind: 'move',
                fromPageNumber: 900_001,
                toPageNumber: 900_000,
                count: 100_000,
            },
        ]);

        const deleteAllButFirst = createDeleteRangesIdentityDelta(pageCount, [{
            startPage: 2,
            endPage: pageCount,
        }]);
        expect(deleteAllButFirst.pages).toBeUndefined();
        expect(deleteAllButFirst.nextPageCount).toBe(1);
        expect(deleteAllButFirst.ranges).toEqual([
            {
                kind: 'retain',
                fromPageNumber: 1,
                toPageNumber: 1,
                count: 1,
            },
            {
                kind: 'delete',
                fromPageNumber: 2,
                count: pageCount - 1,
            },
        ]);
    });

    it('keeps multi-page moves correct when the final destination overlaps the source interval', () => {
        const pageCount = 1_000_000;
        const forward = createMoveIdentityDelta(pageCount, 400_000, 400_001, 2);
        expect(forward.ranges).toEqual([
            {
                kind: 'retain',
                fromPageNumber: 1,
                toPageNumber: 1,
                count: 399_999,
            },
            {
                kind: 'move',
                fromPageNumber: 400_002,
                toPageNumber: 400_000,
                count: 1,
            },
            {
                kind: 'move',
                fromPageNumber: 400_000,
                toPageNumber: 400_001,
                count: 2,
            },
            {
                kind: 'retain',
                fromPageNumber: 400_003,
                toPageNumber: 400_003,
                count: 599_998,
            },
        ]);

        const backward = createMoveIdentityDelta(pageCount, 400_002, 400_001, 2);
        expect(backward.ranges).toEqual([
            {
                kind: 'retain',
                fromPageNumber: 1,
                toPageNumber: 1,
                count: 400_000,
            },
            {
                kind: 'move',
                fromPageNumber: 400_002,
                toPageNumber: 400_001,
                count: 2,
            },
            {
                kind: 'move',
                fromPageNumber: 400_001,
                toPageNumber: 400_003,
                count: 1,
            },
            {
                kind: 'retain',
                fromPageNumber: 400_004,
                toPageNumber: 400_004,
                count: 599_997,
            },
        ]);
    });

    it('keeps the legacy page permutation exact for overlapping small moves', () => {
        expect(createMoveIdentityDelta(6, 2, 3, 2)).toEqual({
            previousPageCount: 6,
            pages: [
                {fromPageNumber: 1},
                {fromPageNumber: 4},
                {fromPageNumber: 2},
                {fromPageNumber: 3},
                {fromPageNumber: 5},
                {fromPageNumber: 6},
            ],
        });
        expect(createMoveIdentityDelta(6, 4, 2, 2)).toEqual({
            previousPageCount: 6,
            pages: [
                {fromPageNumber: 1},
                {fromPageNumber: 4},
                {fromPageNumber: 5},
                {fromPageNumber: 2},
                {fromPageNumber: 3},
                {fromPageNumber: 6},
            ],
        });
    });

    it('rejects duplicate inserted identities in a legacy page delta', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-duplicate-insert-'));
        const path = join(root, 'working.pdf');
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 2,
                storage: 'ranges',
                documentRevisionToken: OLD_TOKEN,
                pageCount: 3,
                identitySeed: 'duplicate-insert-fixture',
                pageIds: [
                    'page-a',
                    'page-b',
                    'page-c',
                ],
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
        ]);

        await expect(commitPageIdentityDelta(path, {
            previousPageCount: 3,
            pages: [
                {fromPageNumber: 1},
                {insertedId: 'inserted-page'},
                {insertedId: 'inserted-page'},
                {fromPageNumber: 2},
            ],
        }, nextRevisionInfo(path))).rejects.toThrow('duplicate or invalid inserted identities');
    });

    it('maps a million-page non-contiguous move with selected-range-sized output', () => {
        const pageCount = 1_000_000;
        const delta = createPageMoveRangesIdentityDelta({
            pageCount,
            ranges: [
                {
                    startPage: 2,
                    endPage: 3,
                },
                {
                    startPage: 5,
                    endPage: 5,
                },
            ],
            insertAt: pageCount,
        });
        expect(delta.pages).toBeUndefined();
        expect(delta.nextPageCount).toBe(pageCount);
        expect(delta.ranges).toEqual([
            {
                kind: 'retain',
                fromPageNumber: 1,
                toPageNumber: 1,
                count: 1,
            },
            {
                kind: 'move',
                fromPageNumber: 4,
                toPageNumber: 2,
                count: 1,
            },
            {
                kind: 'move',
                fromPageNumber: 6,
                toPageNumber: 3,
                count: 999_995,
            },
            {
                kind: 'move',
                fromPageNumber: 2,
                toPageNumber: 999_998,
                count: 2,
            },
            {
                kind: 'move',
                fromPageNumber: 5,
                toPageNumber: 1_000_000,
                count: 1,
            },
        ]);

        expect(createPageMoveRangesIdentityDelta({
            pageCount: 6,
            ranges: [
                {
                    startPage: 2,
                    endPage: 2,
                },
                {
                    startPage: 4,
                    endPage: 5,
                },
            ],
            insertAt: 6,
        }).pages).toEqual([
            {fromPageNumber: 1},
            {fromPageNumber: 3},
            {fromPageNumber: 6},
            {fromPageNumber: 2},
            {fromPageNumber: 4},
            {fromPageNumber: 5},
        ]);
    });

    it('publishes one million-page identities as a sparse sidecar', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-million-'));
        const path = join(root, 'working.pdf');
        const pageCount = 1_000_000;
        const identitySeed = 'million-page-fixture';
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 2,
                storage: 'ranges',
                documentRevisionToken: OLD_TOKEN,
                pageCount,
                identitySeed,
                ranges: [{
                    startPage: 1,
                    count: pageCount,
                    identitySeed,
                    identityStart: 0,
                }],
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
        ]);

        await commitPageIdentityDelta(
            path,
            createMoveIdentityDelta(pageCount, 1, pageCount),
            nextRevisionInfo(path),
        );

        const sidecar = JSON.parse(await readFile(`${path}.evb-pages.json`, 'utf8')) as {
            pageIds?: unknown;
            ranges?: unknown[];
            pageCount: number;
        };
        expect(sidecar.pageCount).toBe(pageCount);
        expect(sidecar.pageIds).toBeUndefined();
        expect(sidecar.ranges).toHaveLength(2);
        await expect(readPageIdentity(path, 1, pageCount)).resolves.toBe(
            derivePageIdentity(identitySeed, 1),
        );
        await expect(readPageIdentity(path, pageCount, pageCount)).resolves.toBe(
            derivePageIdentity(identitySeed, 0),
        );
    });

    it('publishes a sparse touched-page delta without changing its identity', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-touch-'));
        const path = join(root, 'working.pdf');
        const pageCount = 5_000;
        const identitySeed = 'touch-fixture';
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 2,
                storage: 'ranges',
                documentRevisionToken: OLD_TOKEN,
                pageCount,
                identitySeed,
                ranges: [{
                    startPage: 1,
                    count: pageCount,
                    identitySeed,
                    identityStart: 0,
                }],
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
        ]);

        await commitPageIdentityDelta(
            path,
            createRotateIdentityDelta(pageCount, [2_500]),
            nextRevisionInfo(path),
        );

        const sidecar = JSON.parse(await readFile(`${path}.evb-pages.json`, 'utf8')) as {
            ranges?: Array<{
                count: number;
                startPage: number
            }>;
            pageCount: number;
        };
        expect(sidecar.pageCount).toBe(pageCount);
        expect(sidecar.ranges).toEqual([{
            startPage: 1,
            count: pageCount,
            identitySeed,
            identityStart: 0,
        }]);
        await expect(readPageIdentity(path, 2_500, pageCount)).resolves.toBe(
            derivePageIdentity(identitySeed, 2_499),
        );
    });

    it('migrates an oversized v1 identity array through bounded v2 ranges', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-v1-migration-'));
        const path = join(root, 'working.pdf');
        const pageCount = 5_000;
        const pageIds = Array.from({length: pageCount}, (_value, index) => (
            `legacy-page-${String(index).padStart(4, '0')}-${'x'.repeat(900)}`
        ));
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 1,
                documentRevisionToken: OLD_TOKEN,
                pageIds,
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
        ]);

        await commitPageIdentityDelta(
            path,
            createMoveIdentityDelta(pageCount, 1, pageCount),
            nextRevisionInfo(path),
        );

        const migrated = JSON.parse(await readFile(`${path}.evb-pages.json`, 'utf8')) as {
            pageIds?: unknown;
            pageCount: number;
            ranges?: Array<{
                count: number;
                pageIds?: string[]
            }>;
            version: number;
            storage: string;
        };
        expect(migrated.version).toBe(2);
        expect(migrated.storage).toBe('ranges');
        expect(migrated.pageCount).toBe(pageCount);
        expect(migrated.pageIds).toBeUndefined();
        expect(migrated.ranges).toHaveLength(2);
        expect(migrated.ranges?.every(range => range.count <= 4_096)).toBe(true);
        expect(migrated.ranges?.every(range => range.pageIds !== undefined)).toBe(true);
        await expect(readPageIdentity(path, 1, pageCount)).resolves.toBe(pageIds[1]);
        await expect(readPageIdentity(path, pageCount, pageCount)).resolves.toBe(pageIds[0]);
    }, 30_000);

    it('routes a range-only delta through OCR v4 before the v3 fallback', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-ocr-v4-'));
        const path = join(root, 'working.pdf');
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 2,
                storage: 'ranges',
                documentRevisionToken: OLD_TOKEN,
                pageCount: 3,
                identitySeed: 'ocr-v4-fixture',
                pageIds: [
                    'page-a',
                    'page-b',
                    'page-c',
                ],
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
        ]);
        const remap = vi.spyOn(ocrIndexWriter, 'remapOcrCatalogV4PageRanges')
            .mockResolvedValue(true);
        const delta = {
            previousPageCount: 3,
            nextPageCount: 3,
            ranges: [
                {
                    kind: 'move' as const,
                    fromPageNumber: 2,
                    toPageNumber: 1,
                    count: 1,
                },
                {
                    kind: 'move' as const,
                    fromPageNumber: 1,
                    toPageNumber: 2,
                    count: 1,
                },
                {
                    kind: 'retain' as const,
                    fromPageNumber: 3,
                    toPageNumber: 3,
                    count: 1,
                },
            ],
        };
        await commitPageIdentityDelta(path, delta, nextRevisionInfo(path));

        expect(remap).toHaveBeenCalledWith(path, delta, nextRevisionInfo(path));
        expect(delta).not.toHaveProperty('pages');
        const sidecar = JSON.parse(await readFile(`${path}.evb-pages.json`, 'utf8')) as {
            pageIds: string[];
            documentRevisionToken: string;
        };
        expect(sidecar.documentRevisionToken).toBe(NEW_TOKEN);
        expect(sidecar.pageIds).toEqual([
            'page-b',
            'page-a',
            'page-c',
        ]);
    });

    it('migrates a million-page legacy OCR catalog without reading or copying its manifest', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-ocr-v3-large-'));
        const path = join(root, 'working.pdf');
        const pageCount = 1_000_000;
        const ocrPath = `${path}.ocr`;
        await mkdir(ocrPath);
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(join(ocrPath, 'manifest.json'), JSON.stringify({
                version: 3,
                documentRevision: {token: OLD_TOKEN},
                createdAt: 1,
                source: {pdfPath: path},
                pageCount,
                pageBox: 'crop',
                ocr: {
                    engine: 'tesseract',
                    languages: ['eng'],
                    renderDpi: 300,
                },
                pages: {},
            })),
        ]);
        const remap = vi.spyOn(ocrIndexWriter, 'remapOcrCatalogV4PageRanges')
            .mockResolvedValueOnce(false)
            .mockResolvedValue(true);
        const migrate = vi.spyOn(ocrIndexWriter, 'migrateOcrIndexV3ToV4')
            .mockResolvedValue(null);
        fsGuards.forbidRead = true;
        fsGuards.forbidCopy = true;
        const parseSpy = vi.spyOn(JSON, 'parse')
            .mockImplementation(() => {
                throw new Error('whole-manifest parse is forbidden');
            });
        const delta = createMoveIdentityDelta(pageCount, 1, pageCount);
        const nextRevision = nextRevisionInfo(path);

        await commitPageIdentityDelta(path, delta, nextRevision);

        expect(migrate).toHaveBeenCalledWith({
            catalogRoot: ocrPath,
            sourcePdfPath: path,
            workingCopyPath: path,
        });
        expect(remap).toHaveBeenCalledTimes(2);
        expect(remap).toHaveBeenLastCalledWith(path, delta, nextRevision);
        expect(parseSpy).not.toHaveBeenCalled();
    });

    it('rejects publication when the existing sidecar belongs to an older revision', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-stale-'));
        const path = join(root, 'working.pdf');
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 2,
                storage: 'ranges',
                documentRevisionToken: OLD_TOKEN,
                pageCount: 3,
                identitySeed: 'stale-fixture',
                pageIds: [
                    'page-a',
                    'page-b',
                    'page-c',
                ],
            })),
            publishRevisionSidecar(path, NEW_TOKEN),
        ]);

        await expect(commitPageIdentityDelta(
            path,
            createIdentityDelta(3),
            nextRevisionInfo(path),
        )).rejects.toThrow('Page identity state belongs to a stale document revision');
    });

    it('does not recreate a removed working-copy directory after background initialization is cancelled', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-cancel-'));
        const path = join(root, 'working.pdf');
        await writeFile(path, '%PDF fixture');
        vi.mocked(getPdfPageCount).mockClear();
        let releasePageCount!: (pageCount: number) => void;
        vi.mocked(getPdfPageCount).mockImplementationOnce(() => new Promise(resolve => {
            releasePageCount = resolve;
        }));
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
        await vi.waitFor(() => expect(getPdfPageCount).toHaveBeenCalled());
        forgetPageIdentityStoreInitialization(path);
        const signal = vi.mocked(getPdfPageCount).mock.calls.at(-1)?.[1]?.signal;
        expect(signal?.aborted).toBe(true);
        releasePageCount(3);
        await rejection;
        await rm(root, {
            recursive: true,
            force: true,
        });
        await expect(readFile(`${path}.evb-pages.json`, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('publishes deferred initialization with the revision current when initialization starts', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-revision-'));
        const path = join(root, 'working.pdf');
        await writeFile(path, '%PDF fixture');
        schedulePageIdentityStoreInitialization(path, {
            version: 1,
            documentRef: path,
            authority: 'electron-working-copy',
            token: OLD_TOKEN,
            contentRevision: 1,
            mintedAt: 1,
        });

        await publishRevisionSidecar(path, NEW_TOKEN);
        await awaitPageIdentityStoreInitialization(path);

        const sidecar = JSON.parse(await readFile(`${path}.evb-pages.json`, 'utf8')) as {documentRevisionToken: string};
        expect(sidecar.documentRevisionToken).toBe(NEW_TOKEN);
        forgetPageIdentityStoreInitialization(path);
    });

    it('rejects deferred initialization when the working copy revision changes during page discovery', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-revision-race-'));
        const path = join(root, 'working.pdf');
        await writeFile(path, '%PDF fixture');
        await publishRevisionSidecar(path, OLD_TOKEN);
        let releasePageCount!: (pageCount: number) => void;
        vi.mocked(getPdfPageCount).mockImplementationOnce(() => new Promise(resolve => {
            releasePageCount = resolve;
        }));
        schedulePageIdentityStoreInitialization(path, {
            version: 1,
            documentRef: path,
            authority: 'electron-working-copy',
            token: OLD_TOKEN,
            contentRevision: 1,
            mintedAt: 1,
        });

        const task = awaitPageIdentityStoreInitialization(path);
        await vi.waitFor(() => expect(getPdfPageCount).toHaveBeenCalled());
        await publishRevisionSidecar(path, NEW_TOKEN);
        releasePageCount(3);

        await expect(task).rejects.toThrow('Page identity state belongs to a stale document revision');
        await expect(readFile(`${path}.evb-pages.json`, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
        forgetPageIdentityStoreInitialization(path);
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

        const pageIdentity = JSON.parse(await readFile(`${path}.evb-pages.json`, 'utf8')) as {
            version: number;
            storage: string;
            documentRevisionToken: string;
            pageIds: string[];
        };
        expect(pageIdentity.version).toBe(2);
        expect(pageIdentity.storage).toBe('ranges');
        expect(pageIdentity.documentRevisionToken).toBe(newToken);
        expect(pageIdentity.pageIds).toEqual([
            'page-c',
            'page-a',
            'page-b',
        ]);
        const ocrManifest = JSON.parse(await readFile(join(ocrPath, 'manifest.json'), 'utf8')) as {
            documentRevision: {token: string};
            pages: Record<string, {generation?: string}>;
        };
        expect(ocrManifest.documentRevision.token).toBe(newToken);
        expect([
            ocrManifest.pages['1']?.generation,
            ocrManifest.pages['2']?.generation,
            ocrManifest.pages['3']?.generation,
        ]).toEqual([
            'ocr-run-two',
            'ocr-run-one',
            'ocr-run-one',
        ]);
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

    it('invalidates sparse high-page-count search sidecars without loading or persisting them', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-page-identity-xlarge-'));
        const path = join(root, 'working.pdf');
        const pageCount = 201;
        await Promise.all([
            writeFile(path, '%PDF fixture'),
            writeFile(`${path}.evb-pages.json`, JSON.stringify({
                version: 1,
                documentRevisionToken: OLD_TOKEN,
                pageIds: Array.from({length: pageCount}, (_value, index) => `page-${index}`),
            })),
            publishRevisionSidecar(path, OLD_TOKEN),
            writeFile(`${path}.index.json`, JSON.stringify({
                schemaVersion: 7,
                documentRevision: {token: OLD_TOKEN},
                pdfPath: path,
                createdAt: 1,
                pageCount,
                pages: [{
                    pageNumber: 1,
                    text: 'sparse',
                }],
            })),
        ]);
        await persistCompactSearchIndexStreaming(
            path,
            {
                documentRevision: OLD_TOKEN,
                pageCount,
            },
            [{
                pageNumber: 1,
                text: 'sparse',
            }],
        );

        const loadLegacy = vi.spyOn(searchIndexBuilder, 'loadSearchIndex');
        const loadCompact = vi.spyOn(searchIndexSidecar, 'loadCompactSearchIndex');
        const persistCompact = vi.spyOn(searchIndexSidecar, 'persistCompactSearchIndex');

        await commitPageIdentityDelta(
            path,
            createIdentityDelta(pageCount),
            nextRevisionInfo(path),
        );

        expect(loadLegacy).not.toHaveBeenCalled();
        expect(loadCompact).not.toHaveBeenCalled();
        expect(persistCompact).not.toHaveBeenCalled();
        await expect(stat(`${path}.index.json`)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(stat(`${path}.index.evb-search-v2.bin`)).rejects.toMatchObject({code: 'ENOENT'});
    });
});
