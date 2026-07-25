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
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {rebindDocumentTextCatalogRevision} from '@electron/ocr/documentTextCatalog';

const OLD_TOKEN = requireDocumentRevisionToken('drt1:rebind:old');
const NEW_TOKEN = requireDocumentRevisionToken('drt1:rebind:new');

let root = '';

afterEach(async () => {
    await rm(root, {
        recursive: true,
        force: true,
    });
});

async function seedCatalog(pageCount: number) {
    root = await mkdtemp(join(tmpdir(), 'evb-ocr-rebind-'));
    const path = join(root, 'working.pdf');
    const catalogPath = `${path}.ocr`;
    await mkdir(catalogPath);
    const pages: Record<number, {path: string}> = {};
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const pageFile = `page-${String(pageNumber).padStart(4, '0')}.json`;
        pages[pageNumber] = {path: pageFile};
        await writeFile(join(catalogPath, pageFile), JSON.stringify({
            rotation: 0,
            render: {
                dpi: 300,
                imagePx: {
                    w: 1200,
                    h: 1600,
                },
            },
            text: `page ${pageNumber}`,
            words: [],
        }));
    }
    await writeFile(join(catalogPath, 'manifest.json'), JSON.stringify({
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
        pages,
    }));
    return {
        path,
        catalogPath,
    };
}

async function describePageFiles(catalogPath: string) {
    const names = (await readdir(catalogPath)).filter(name => name !== 'manifest.json').sort();
    const described = await Promise.all(names.map(async name => [
        name,
        (await stat(join(catalogPath, name))).ino,
    ] as const));
    return Object.fromEntries(described);
}

describe('OCR catalog revision rebind', () => {
    it('re-keys an annotation save through the manifest without touching page artifacts', async () => {
        const {
            path,
            catalogPath,
        } = await seedCatalog(5);
        const before = await describePageFiles(catalogPath);

        await rebindDocumentTextCatalogRevision(path, OLD_TOKEN, NEW_TOKEN);

        expect(await describePageFiles(catalogPath)).toEqual(before);
        const manifest = JSON.parse(await readFile(join(catalogPath, 'manifest.json'), 'utf8')) as {
            documentRevision: {token: string};
            pages: Record<string, {path: string}>;
        };
        expect(manifest.documentRevision.token).toBe(NEW_TOKEN);
        expect(Object.keys(manifest.pages)).toHaveLength(5);
    });

    it('refuses to re-key a catalog that is not on the expected revision', async () => {
        const {path} = await seedCatalog(1);

        await expect(rebindDocumentTextCatalogRevision(path, NEW_TOKEN, NEW_TOKEN))
            .rejects.toThrow('OCR DocumentTextCatalog is missing or stale');
    });
});
