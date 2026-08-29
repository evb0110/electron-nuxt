import {
    describe,
    expect,
    it,
} from 'vitest';
import {resolveThumbnailVirtualPages} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailLayout';

describe('resolveThumbnailVirtualPages', () => {
    it('keeps current-page neighbors inside the active physical segment', () => {
        expect(resolveThumbnailVirtualPages(
            99,
            99,
            100,
            1,
            {
                endPage: 100,
                startPage: 98,
            },
        )).toEqual([
            98,
            99,
            100,
        ]);
    });
});
