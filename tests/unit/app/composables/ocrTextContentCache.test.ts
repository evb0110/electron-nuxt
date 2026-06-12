import {
    describe,
    expect,
    it,
} from 'vitest';
import { createOcrTextContentCache } from '@app/modules/pdf-viewer/engine/ocr-text-content-cache/createOcrTextContentCache';

function makeManifest(id: string) {
    return {
        version: 2,
        createdAt: 1,
        source: {pdfPath: `/tmp/${id}.pdf`},
        pageCount: 1,
        pageBox: 'crop' as const,
        ocr: {
            engine: 'tesseract' as const,
            languages: ['eng'],
            renderDpi: 300,
        },
        pages: {1: {path: 'page-1.json'}},
    };
}

function makePageData(text: string) {
    return {
        pageNumber: 1,
        rotation: 0 as const,
        render: {
            dpi: 300,
            imagePx: {
                w: 100,
                h: 100,
            },
        },
        text,
        words: [{
            text,
            x: 0,
            y: 0,
            width: 10,
            height: 10,
        }],
    };
}

describe('ocrTextContentCache', () => {
    it('evicts the least-recently-used manifest and bounds page cache size by count and bytes', () => {
        const cache = createOcrTextContentCache({
            maxManifestEntries: 2,
            maxPageEntries: 2,
            maxPageBytes: 1000,
        });

        cache.setManifest('/tmp/doc-a.pdf', makeManifest('doc-a'));
        cache.setManifest('/tmp/doc-b.pdf', makeManifest('doc-b'));
        expect(cache.getManifest('/tmp/doc-a.pdf')).toEqual(makeManifest('doc-a'));

        cache.setManifest('/tmp/doc-c.pdf', makeManifest('doc-c'));
        expect(cache.getManifest('/tmp/doc-a.pdf')).toEqual(makeManifest('doc-a'));
        expect(cache.getManifest('/tmp/doc-b.pdf')).toBeUndefined();

        const firstPage = makePageData('a'.repeat(150));
        const secondPage = makePageData('b'.repeat(150));

        cache.setPageData('/tmp/doc-a.pdf', 1, firstPage);
        expect(cache.getPageData('/tmp/doc-a.pdf', 1)).toEqual(firstPage);
        cache.setPageData('/tmp/doc-b.pdf', 1, secondPage);

        expect(cache.getPageData('/tmp/doc-a.pdf', 1)).toBeUndefined();
        expect(cache.getPageData('/tmp/doc-b.pdf', 1)).toEqual(secondPage);
        expect(cache.getStats().pageEntries).toBe(1);
        expect(cache.getStats().pageBytes).toBeLessThanOrEqual(1000);
    });

    it('clears a single path without touching other cached documents', () => {
        const cache = createOcrTextContentCache();

        cache.setManifest('/tmp/doc-a.pdf', makeManifest('doc-a'));
        cache.setManifest('/tmp/doc-b.pdf', makeManifest('doc-b'));
        cache.setPageData('/tmp/doc-a.pdf', 1, makePageData('alpha'));
        cache.setPageData('/tmp/doc-b.pdf', 1, makePageData('beta'));

        cache.clearCache('/tmp/doc-a.pdf');

        expect(cache.getManifest('/tmp/doc-a.pdf')).toBeUndefined();
        expect(cache.getPageData('/tmp/doc-a.pdf', 1)).toBeUndefined();
        expect(cache.getManifest('/tmp/doc-b.pdf')).toEqual(makeManifest('doc-b'));
        expect(cache.getPageData('/tmp/doc-b.pdf', 1)).toEqual(makePageData('beta'));
    });
});
