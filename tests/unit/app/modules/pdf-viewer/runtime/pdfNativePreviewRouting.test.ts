import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFJS_NATIVE_PREVIEW_MIN_BYTES,
    isPathPdfSource,
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
});
