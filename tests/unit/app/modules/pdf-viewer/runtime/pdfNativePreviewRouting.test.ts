import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFJS_NATIVE_PREVIEW_MIN_BYTES,
    isPathPdfSource,
    shouldStageNativePdfOpeningPreview,
    shouldUseNativePdfPreview,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfNativePreviewRouting';

describe('pdfNativePreviewRouting', () => {
    it('routes only oversized desktop path-backed PDFs to native preview', () => {
        expect(shouldUseNativePdfPreview({
            kind: 'path',
            path: '/tmp/huge.pdf',
            size: PDFJS_NATIVE_PREVIEW_MIN_BYTES,
        })).toBe(true);

        expect(shouldUseNativePdfPreview({
            kind: 'path',
            path: '/tmp/normal.pdf',
            size: PDFJS_NATIVE_PREVIEW_MIN_BYTES - 1,
        })).toBe(false);

        expect(shouldUseNativePdfPreview({
            kind: 'path',
            path: 'browser://documents/source/huge.pdf',
            size: PDFJS_NATIVE_PREVIEW_MIN_BYTES,
        })).toBe(false);

        expect(shouldUseNativePdfPreview(new Blob([Uint8Array.of(1, 2, 3)]))).toBe(false);
    });

    it('recognizes path-backed PDF source objects', () => {
        expect(isPathPdfSource({
            kind: 'path',
            path: '/tmp/a.pdf',
            size: 1,
        })).toBe(true);

        expect(isPathPdfSource(new Blob([Uint8Array.of(1)]))).toBe(false);
        expect(isPathPdfSource(null)).toBe(false);
    });

    it('stages a sub-threshold page-heavy non-linearized PDF without changing its final viewer route', () => {
        const source = {
            kind: 'path' as const,
            path: '/tmp/dictionary.pdf',
            size: 170_496_793,
        };
        const openingGeometry = {
            pageNumber: 1 as const,
            pageCount: 1_859,
            width: 612,
            height: 792,
            rotation: 0 as const,
            size: source.size,
            modifiedAt: 1_724_000_000_000,
            linearized: false,
        };

        expect(shouldUseNativePdfPreview(source)).toBe(false);
        expect(shouldStageNativePdfOpeningPreview(source, openingGeometry)).toBe(true);
        expect(shouldStageNativePdfOpeningPreview(source, {
            ...openingGeometry,
            linearized: true,
        })).toBe(false);
        expect(shouldStageNativePdfOpeningPreview(source, {
            ...openingGeometry,
            pageCount: 999,
        })).toBe(false);
    });
});
