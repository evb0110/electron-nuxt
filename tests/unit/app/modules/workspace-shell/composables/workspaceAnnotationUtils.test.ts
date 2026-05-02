import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
    createSerializeCurrentPdfForEmbeddedFallback,
    hasAnnotationChanges,
    hasViewerShapeChanges,
} from '@app/modules/workspace-shell/composables/workspace-annotation-utils';

describe('hasViewerShapeChanges', () => {
    it('unwraps ref-backed viewer shape state', () => {
        expect(hasViewerShapeChanges({ hasShapes: ref(true) })).toBe(true);
        expect(hasViewerShapeChanges({ hasShapes: ref(false) })).toBe(false);
    });

    it('falls back to plain booleans and null viewers', () => {
        expect(hasViewerShapeChanges({ hasShapes: true })).toBe(true);
        expect(hasViewerShapeChanges({ hasShapes: false })).toBe(false);
        expect(hasViewerShapeChanges(null)).toBe(false);
    });
});

describe('hasAnnotationChanges', () => {
    it('returns true when viewer reports shape changes through a ref', () => {
        const result = hasAnnotationChanges({
            pdfViewerRef: ref({
                saveDocument: async () => new Uint8Array([]),
                hasShapes: ref(true),
                getAllShapes: () => [],
            }),
            pdfDocument: shallowRef(null),
        });

        expect(result).toBe(true);
    });

    it('returns false when viewer shape ref is false', () => {
        const result = hasAnnotationChanges({
            pdfViewerRef: ref({
                saveDocument: async () => new Uint8Array([]),
                hasShapes: ref(false),
                getAllShapes: () => [],
            }),
            pdfDocument: shallowRef(null),
        });

        expect(result).toBe(false);
    });

    it('returns true when annotation storage has modified ids', () => {
        const pdfDocument = {annotationStorage: {modifiedIds: {ids: new Set(['1R0'])}}} as Partial<PDFDocumentProxy> as PDFDocumentProxy;

        const result = hasAnnotationChanges({
            pdfViewerRef: ref(null),
            pdfDocument: shallowRef(pdfDocument),
        });

        expect(result).toBe(true);
    });

    it('returns true when annotation storage has serializable entries without modified ids', () => {
        const pdfDocument = {annotationStorage: {
            modifiedIds: {ids: new Set()},
            serializable: {map: new Map([[
                'pdfjs_internal_editor_0',
                {value: 'changed'},
            ]])},
        }} as Partial<PDFDocumentProxy> as PDFDocumentProxy;

        const result = hasAnnotationChanges({
            pdfViewerRef: ref(null),
            pdfDocument: shallowRef(pdfDocument),
        });

        expect(result).toBe(true);
    });

    it('returns false when annotation storage access fails', () => {
        const throwingDocument = {} as Partial<PDFDocumentProxy> as PDFDocumentProxy;
        Object.defineProperty(throwingDocument, 'annotationStorage', {get: () => {
            throw new Error('bad storage');
        }});

        const result = hasAnnotationChanges({
            pdfViewerRef: ref(null),
            pdfDocument: shallowRef(throwingDocument),
        });

        expect(result).toBe(false);
    });
});

describe('createSerializeCurrentPdfForEmbeddedFallback', () => {
    it('saves, reloads and restores current page', async () => {
        const saveDocument = vi.fn(async () => new Uint8Array([
            1,
            2,
            3,
        ]));
        const waitForPdfReload = vi.fn(async () => undefined);
        const loadPdfFromData = vi.fn(async () => undefined);

        const serialize = createSerializeCurrentPdfForEmbeddedFallback({
            pdfViewerRef: ref({
                saveDocument,
                getAllShapes: () => [],
            }),
            currentPage: ref(7),
            workingCopyPath: ref('/tmp/working.pdf'),
            waitForPdfReload,
            loadPdfFromData,
        });

        const result = await serialize();

        expect(result).toBe(true);
        expect(saveDocument).toHaveBeenCalledTimes(1);
        expect(waitForPdfReload).toHaveBeenCalledWith(7);
        expect(loadPdfFromData).toHaveBeenCalledWith(new Uint8Array([
            1,
            2,
            3,
        ]), {
            pushHistory: true,
            persistWorkingCopy: true,
        });
    });

    it('returns false when viewer save returns null', async () => {
        const serialize = createSerializeCurrentPdfForEmbeddedFallback({
            pdfViewerRef: ref({
                saveDocument: async () => null,
                getAllShapes: () => [],
            }),
            currentPage: ref(1),
            workingCopyPath: ref(null),
            waitForPdfReload: async () => undefined,
            loadPdfFromData: async () => undefined,
        });

        await expect(serialize()).resolves.toBe(false);
    });
});
