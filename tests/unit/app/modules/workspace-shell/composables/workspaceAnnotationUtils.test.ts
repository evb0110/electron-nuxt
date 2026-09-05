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
import { hasAnnotationChanges } from '@app/modules/workspace-shell/annotations/hasAnnotationChanges';
import { hasViewerShapeChanges } from '@app/modules/workspace-shell/annotations/hasViewerShapeChanges';

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

    it('uses canonical shape dirtiness when the viewer exposes it', () => {
        expect(hasViewerShapeChanges({
            hasCanonicalShapeChanges: () => false,
            hasShapes: ref(true),
        })).toBe(false);
        expect(hasViewerShapeChanges({
            hasCanonicalShapeChanges: () => true,
            hasShapes: ref(false),
        })).toBe(true);
    });
});

describe('hasAnnotationChanges', () => {
    it('reports canonical annotation changes even when PDF.js storage is clean', () => {
        const result = hasAnnotationChanges({
            pdfViewerRef: ref({
                getAllShapes: () => [],
                hasCanonicalAnnotationChanges: () => true,
                runSaveTransaction: vi.fn(),
            }),
            pdfDocument: shallowRef(null),
        });

        expect(result).toBe(true);
    });

    it('returns true when viewer reports shape changes through a ref', () => {
        const result = hasAnnotationChanges({
            pdfViewerRef: ref({
                runSaveTransaction: vi.fn(),
                hasShapes: ref(true),
                getAllShapes: () => [],
            }),
            pdfDocument: shallowRef(null),
        });

        expect(result).toBe(true);
    });

    it('does not treat a clean imported shape as a change', () => {
        const result = hasAnnotationChanges({
            pdfViewerRef: ref({
                runSaveTransaction: vi.fn(),
                hasCanonicalAnnotationChanges: () => false,
                hasCanonicalShapeChanges: () => false,
                hasShapes: ref(true),
                getAllShapes: () => [],
            }),
            pdfDocument: shallowRef(null),
        });

        expect(result).toBe(false);
    });

    it('returns false when viewer shape ref is false', () => {
        const result = hasAnnotationChanges({
            pdfViewerRef: ref({
                runSaveTransaction: vi.fn(),
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

    it('uses the viewer-bound canonical collector for a clean persisted comment anchor', () => {
        const pdfDocument = {annotationStorage: {
            modifiedIds: {ids: new Set()},
            serializable: {map: new Map([[
                'pdfjs_internal_editor_0',
                {
                    annotationType: 3,
                    value: '\u200B',
                    popup: {
                        contents: 'saved note',
                        deleted: false,
                    },
                },
            ]])},
        }} as Partial<PDFDocumentProxy> as PDFDocumentProxy;

        const collectLiveAnnotationChanges = vi.fn(() => ({
            ids: new Set<string>(),
            replayableEditorNoteIds: new Set<string>(),
            nativeFreeTextEditors: new Map(),
            hasChanges: false,
            hasUnknownChanges: false,
            fingerprint: 'empty',
        }));
        const result = hasAnnotationChanges({
            pdfViewerRef: ref({
                collectLiveAnnotationChanges,
                getAllShapes: () => [],
                runSaveTransaction: vi.fn(),
            }),
            pdfDocument: shallowRef(pdfDocument),
        });

        expect(result).toBe(false);
        expect(collectLiveAnnotationChanges).toHaveBeenCalled();
    });

    it('returns true when annotation storage access fails', () => {
        const throwingDocument = {} as Partial<PDFDocumentProxy> as PDFDocumentProxy;
        Object.defineProperty(throwingDocument, 'annotationStorage', {get: () => {
            throw new Error('bad storage');
        }});

        const result = hasAnnotationChanges({
            pdfViewerRef: ref(null),
            pdfDocument: shallowRef(throwingDocument),
        });

        expect(result).toBe(true);
    });
});
