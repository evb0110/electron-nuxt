import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    parsePdfInfoPageSizes,
    parsePdfOpeningGeometryMetadata,
} from '@electron/features/documents/main/nativePdfPreview';

describe('native PDF preview metadata parsing', () => {
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
