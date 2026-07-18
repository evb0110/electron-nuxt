import {
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
}));

vi.mock('@electron/djvu/metadata', () => ({getDjvuPageCount: mocks.getPageCount}));
vi.mock('@electron/features/djvu/public', () => ({
    convertDjvuPageToImage: mocks.convertPage,
    getDjvuPageSizesForViewing: mocks.getPageSizes,
}));
vi.mock('@electron/features/image-export/main/export', () => ({convertRenderedPpmToPng: mocks.convertPpmToPng}));
vi.mock('@electron/features/image-export/main/tryCombinePagesWithNativeTiffCombiner', () => ({tryCombinePagesWithNativeTiffCombiner: mocks.combineTiff}));
vi.mock('@electron/resources/jobBroker', () => ({mainJobBroker: {acquire: mocks.acquire}}));

describe('DjVu image export limits', () => {
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
});
