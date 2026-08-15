import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    parsePdfInfoPageSizes,
    parsePdfOpeningGeometryMetadata,
    readJpegDimensions,
} from '@electron/features/documents/main/nativePdfPreview';

describe('native PDF preview metadata parsing', () => {
    it('reads dimensions from the final JPEG raster', () => {
        const bytes = Uint8Array.of(
            0xff, 0xd8,
            0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
            0xff, 0xc2, 0x00, 0x0b, 0x08, 0x04, 0x38, 0x07, 0x80, 0x01, 0x01, 0x11, 0x00,
            0xff, 0xd9,
        );

        expect(readJpegDimensions(bytes)).toEqual({
            width: 1_920,
            height: 1_080,
        });
    });

    it('rejects a malformed native preview JPEG', () => {
        expect(() => readJpegDimensions(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)))
            .toThrow('invalid JPEG');
    });

    it('parses per-page sizes from pdfinfo -box output', () => {
        expect(parsePdfInfoPageSizes(`
Pages:           3
Page    1 size:  595.32 x 838.68 pts
Page    2 size:  595.32 x 838.68 pts
Page    3 size:  595.32 x 820.32 pts
`, 3, null)).toEqual([
            {
                width: 595.32,
                height: 838.68,
            },
            {
                width: 595.32,
                height: 838.68,
            },
            {
                width: 595.32,
                height: 820.32,
            },
        ]);
    });

    it('fills missing page sizes with the default size', () => {
        expect(parsePdfInfoPageSizes(`
Pages:           3
Page size:       612 x 792 pts (letter)
Page    2 size:  400 x 500 pts
`, 3, {
            width: 612,
            height: 792,
        })).toEqual([
            {
                width: 612,
                height: 792,
            },
            {
                width: 400,
                height: 500,
            },
            {
                width: 612,
                height: 792,
            },
        ]);
    });

    it('parses normalized first-page geometry without allocating all page sizes', () => {
        expect(parsePdfOpeningGeometryMetadata(`
Pages:           431
Page    1 size:  612 x 792 pts (letter)
Page    1 rot:   -90
`, {
            size: 28_000_000,
            modifiedAt: 1_720_000_000_000,
        })).toEqual({
            pageNumber: 1,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 270,
            size: 28_000_000,
            modifiedAt: 1_720_000_000_000,
        });
    });
});
