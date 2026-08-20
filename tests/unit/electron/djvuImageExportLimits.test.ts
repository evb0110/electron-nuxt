import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    getPageCount: vi.fn(),
    getPageSizes: vi.fn(),
    convertPage: vi.fn(),
    convertPpmToPng: vi.fn(),
    combineTiff: vi.fn(),
    acquire: vi.fn(),
    promoteStagedFiles: vi.fn(),
}));

vi.mock('@electron/djvu/metadata', () => ({getDjvuPageCount: mocks.getPageCount}));
vi.mock('@electron/features/djvu/public', () => ({
    convertDjvuPageToImage: mocks.convertPage,
    getDjvuPageSizesForViewing: mocks.getPageSizes,
}));
vi.mock('@electron/features/image-export/main/export', () => ({
    convertRenderedPpmToPng: mocks.convertPpmToPng,
    promoteStagedFiles: mocks.promoteStagedFiles,
}));
vi.mock('@electron/features/image-export/main/tryCombinePagesWithNativeTiffCombiner', () => ({tryCombinePagesWithNativeTiffCombiner: mocks.combineTiff}));
vi.mock('@electron/resources/jobBroker', () => ({mainJobBroker: {acquire: mocks.acquire}}));

describe('DjVu image export limits', () => {
    let tempDir = '';
    afterEach(async () => rm(tempDir, {
        recursive: true,
        force: true,
    }));

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getPageCount.mockResolvedValue(1);
        mocks.getPageSizes.mockResolvedValue([{
            width: 1_000,
            height: 1_000,
            dpi: 300,
        }]);
    });

    it('refuses an oversized page before starting a PNG render process', async () => {
        mocks.getPageSizes.mockResolvedValue([{
            width: 8_193,
            height: 100,
            dpi: 300,
        }]);
        const {exportDjvuPagesAsPng} = await import(
            '@electron/features/image-export/main/djvuImageExport'
        );

        await expect(exportDjvuPagesAsPng('/books/large.djvu', '/exports/page.png'))
            .rejects.toThrow('exceeds the image export raster limit');
        expect(mocks.convertPage).not.toHaveBeenCalled();
        expect(mocks.acquire).not.toHaveBeenCalled();
    });

    it('refuses a multi-page TIFF above the aggregate raster budget before rendering', async () => {
        mocks.getPageCount.mockResolvedValue(5);
        mocks.getPageSizes.mockResolvedValue(Array.from(
            {length: 5},
            () => ({
                width: 8_000,
                height: 8_000,
                dpi: 300,
            }),
        ));
        const {exportDjvuAsMultiPageTiff} = await import(
            '@electron/features/image-export/main/djvuImageExport'
        );

        await expect(exportDjvuAsMultiPageTiff('/books/large.djvu', '/exports/book.tiff'))
            .rejects.toThrow('aggregate-pixel limit');
        expect(mocks.convertPage).not.toHaveBeenCalled();
        expect(mocks.acquire).not.toHaveBeenCalled();
    });

    it('does not promote an early PNG page when a later render fails', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'djvu-png-transaction-test-'));
        mocks.getPageCount.mockResolvedValue(2);
        mocks.getPageSizes.mockResolvedValue(Array.from({length: 2}, () => ({
            width: 1_000,
            height: 1_000,
            dpi: 300,
        })));
        mocks.acquire.mockResolvedValue({release: vi.fn()});
        mocks.convertPage.mockImplementation(async (_source: string, ppmPath: string, page: number) => {
            if (page === 2) throw new Error('second page failed');
            await writeFile(ppmPath, 'ppm');
            return {
                success: true,
                outputPath: ppmPath,
                fileSize: 3,
            };
        });
        mocks.convertPpmToPng.mockImplementation(async (ppmPath: string) => {
            const pngPath = `${ppmPath}.png`;
            await writeFile(pngPath, 'png');
            return pngPath;
        });
        const {exportDjvuPagesAsPng} = await import(
            '@electron/features/image-export/main/djvuImageExport'
        );

        await expect(exportDjvuPagesAsPng(
            '/books/failure.djvu',
            join(tempDir, 'page.png'),
            {scratch: {using: async (_prefix, run) => run(tempDir)}},
        )).rejects.toThrow('second page failed');

        expect(mocks.promoteStagedFiles).not.toHaveBeenCalled();
    });
});
