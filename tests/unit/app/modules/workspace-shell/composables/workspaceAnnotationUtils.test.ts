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
import { createSerializeCurrentPdfForEmbeddedFallback } from '@app/modules/workspace-shell/annotations/createSerializeCurrentPdfForEmbeddedFallback';
import { hasAnnotationChanges } from '@app/modules/workspace-shell/annotations/hasAnnotationChanges';
import { hasViewerShapeChanges } from '@app/modules/workspace-shell/annotations/hasViewerShapeChanges';

function createSaveTransaction(bytes: Uint8Array | null) {
    return vi.fn(async () => ({
        source: 'pdfjs-materialize' as const,
        baseBytes: null,
        serializedBytes: bytes,
        serializedResult: null,
        nativeMutationPlan: null,
        annotationSavePlan: {
            route: 'source-clean' as const,
            expectedCost: 'small' as const,
            reason: 'no-live-pdfjs-annotation-work' as const,
            unreplayableLiveAnnotationIds: [],
        },
        annotationCommentsSnapshot: [],
        pendingEmbeddedTextUpdates: new Map(),
        pendingEmbeddedAnnotationDeletes: [],
        restoreConsumedPendingEmbeddedMutations: vi.fn(),
        commitConsumedPendingEmbeddedMutations: vi.fn(),
    }));
}

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
                runSaveTransaction: createSaveTransaction(new Uint8Array([])),
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
                runSaveTransaction: createSaveTransaction(new Uint8Array([])),
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

describe('createSerializeCurrentPdfForEmbeddedFallback', () => {
    it('saves, reloads and restores current page', async () => {
        const savedBytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        const runSaveTransaction = createSaveTransaction(savedBytes);
        const waitForPdfReload = vi.fn(async () => undefined);
        const loadPdfFromData = vi.fn(async () => undefined);

        const serialize = createSerializeCurrentPdfForEmbeddedFallback({
            pdfViewerRef: ref({
                runSaveTransaction,
                getAllShapes: () => [],
            }),
            currentPage: ref(7),
            workingCopyPath: ref('/tmp/working.pdf'),
            waitForPdfReload,
            loadPdfFromData,
        });

        const result = await serialize();

        expect(result).toBe(savedBytes);
        expect(runSaveTransaction).toHaveBeenCalledWith({
            mode: 'embedded-mutation',
            forcePdfjsMaterialize: true,
        });
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
                runSaveTransaction: createSaveTransaction(null),
                getAllShapes: () => [],
            }),
            currentPage: ref(1),
            workingCopyPath: ref(null),
            waitForPdfReload: async () => undefined,
            loadPdfFromData: async () => undefined,
        });

        await expect(serialize()).resolves.toBeNull();
    });
});
