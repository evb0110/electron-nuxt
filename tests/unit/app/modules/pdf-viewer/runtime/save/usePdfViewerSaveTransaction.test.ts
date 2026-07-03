import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfViewerSaveTransaction } from '@app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction';

describe('usePdfViewerSaveTransaction', () => {
    it('materializes through the existing PDF.js save path for the initial facade', async () => {
        const bytes = new Uint8Array([
            10,
            20,
        ]);
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => bytes);
        const { runSaveTransaction } = usePdfViewerSaveTransaction({materializePdfJsDocumentForInternalUse});

        const result = await runSaveTransaction({mode: 'persist'});

        expect(materializePdfJsDocumentForInternalUse).toHaveBeenCalledOnce();
        expect(result.source).toBe('pdfjs-materialize');
        expect(result.baseBytes).toBeNull();
        expect(result.serializedBytes).toBe(bytes);
        expect(result.nativeMutationPlan).toBeNull();
        expect(result.annotationSavePlan).toMatchObject({
            route: 'source-clean',
            reason: 'no-live-pdfjs-annotation-work',
        });
        expect(result.annotationCommentsSnapshot).toEqual([]);
        expect(result.pendingEmbeddedTextUpdates.size).toBe(0);
        expect(result.pendingEmbeddedAnnotationDeletes).toEqual([]);
        expect(result.restoreConsumedPendingEmbeddedMutations()).toBeUndefined();
        expect(result.commitConsumedPendingEmbeddedMutations()).toBeUndefined();
    });

    it('flushes annotation mutations before committing PDF.js editors', async () => {
        const events: string[] = [];
        const { runSaveTransaction } = usePdfViewerSaveTransaction({
            flushAnnotationMutationsForSave: vi.fn(async () => {
                events.push('flush');
            }),
            commitPdfEditorsForSave: vi.fn(async () => {
                events.push('commit');
            }),
            materializePdfJsDocumentForInternalUse: vi.fn(async () => {
                events.push('materialize');
                return new Uint8Array([1]);
            }),
        });

        await runSaveTransaction({mode: 'persist'});

        expect(events).toEqual([
            'flush',
            'commit',
            'materialize',
        ]);
    });

    it('consumes pending embedded mutations through the transaction hooks', async () => {
        const restore = vi.fn();
        const commit = vi.fn();
        const pendingTexts = new Map<string, string>().set('stable-1', 'updated');
        const pendingDeletes = [{
            id: 'ann-1',
            stableKey: 'stable-1',
            pageIndex: 0,
            pageNumber: 1,
            text: 'note',
            author: null,
            modifiedAt: null,
            color: null,
            uid: null,
            annotationId: '12R0',
            source: 'pdf' as const,
        }];
        const { runSaveTransaction } = usePdfViewerSaveTransaction({
            materializePdfJsDocumentForInternalUse: vi.fn(async () => new Uint8Array([1])),
            consumePendingEmbeddedMutations: vi.fn(() => ({
                pendingEmbeddedTextUpdates: pendingTexts,
                pendingEmbeddedAnnotationDeletes: pendingDeletes,
                restore,
                commit,
            })),
        });

        const result = await runSaveTransaction({
            mode: 'persist',
            consumePendingEmbeddedMutations: true,
        });

        expect(result.pendingEmbeddedTextUpdates).toEqual(pendingTexts);
        expect(result.pendingEmbeddedAnnotationDeletes).toEqual(pendingDeletes);
        result.restoreConsumedPendingEmbeddedMutations();
        result.commitConsumedPendingEmbeddedMutations();
        expect(restore).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenCalledOnce();
    });

    it('uses source bytes for replayable embedded annotation changes', async () => {
        const sourceBytes = new Uint8Array([
            4,
            5,
        ]);
        const getSourcePdfData = vi.fn(async () => sourceBytes);
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => new Uint8Array([9]));
        const { runSaveTransaction } = usePdfViewerSaveTransaction({materializePdfJsDocumentForInternalUse});

        const result = await runSaveTransaction({
            mode: 'persist',
            pendingEmbeddedTextUpdates: new Map([[
                'ann:0:12R0',
                'updated',
            ]]),
            source: {getSourcePdfData},
        });

        expect(getSourcePdfData).toHaveBeenCalledOnce();
        expect(materializePdfJsDocumentForInternalUse).not.toHaveBeenCalled();
        expect(result.source).toBe('source-replay');
        expect(result.baseBytes).toBe(sourceBytes);
        expect(result.serializedBytes).toBeNull();
        expect(result.serializedResult).toBeNull();
        expect(result.annotationSavePlan).toMatchObject({
            route: 'source-replay',
            reason: 'pending-embedded-annotation-operations',
        });
    });

    it('forces PDF.js materialization even when source bytes are available', async () => {
        const materializedBytes = new Uint8Array([
            7,
            8,
        ]);
        const getSourcePdfData = vi.fn(async () => new Uint8Array([1]));
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => materializedBytes);
        const { runSaveTransaction } = usePdfViewerSaveTransaction({materializePdfJsDocumentForInternalUse});

        const result = await runSaveTransaction({
            mode: 'persist',
            forcePdfjsMaterialize: true,
            source: {getSourcePdfData},
        });

        expect(getSourcePdfData).not.toHaveBeenCalled();
        expect(materializePdfJsDocumentForInternalUse).toHaveBeenCalledOnce();
        expect(result.source).toBe('pdfjs-materialize');
        expect(result.baseBytes).toBe(materializedBytes);
        expect(result.serializedBytes).toBeNull();
        expect(result.serializedResult).toBeNull();
        expect(result.annotationSavePlan).toMatchObject({
            route: 'pdfjs-materialize',
            reason: 'saved-pdfjs-annotation-baseline-diverged',
        });
    });

    it('serializes the selected base bytes inside the transaction when requested', async () => {
        const sourceBytes = new Uint8Array([
            1,
            2,
        ]);
        const finalBytes = new Uint8Array([
            3,
            4,
        ]);
        const pendingTexts = new Map([[
            'ann:0:12R0',
            'updated',
        ]]);
        const getSourcePdfData = vi.fn(async () => sourceBytes);
        const serializePdfForSave = vi.fn(async () => finalBytes);
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => new Uint8Array([9]));
        const annotationCommentsSnapshot = [{
            id: 'ann-1',
            stableKey: 'ann:0:12R0',
            pageIndex: 0,
            pageNumber: 1,
            text: 'note',
            author: null,
            modifiedAt: null,
            color: null,
            uid: null,
            annotationId: '12R0',
            source: 'pdf' as const,
        }];
        const { runSaveTransaction } = usePdfViewerSaveTransaction({materializePdfJsDocumentForInternalUse});

        const result = await runSaveTransaction({
            mode: 'persist',
            saveMode: 'save_as_rewrite',
            pendingEmbeddedTextUpdates: pendingTexts,
            annotationCommentsSnapshot,
            source: {
                getSourcePdfData,
                serializePdfForSave,
            },
            serializeResult: true,
            forceRewrite: true,
            includeManagedShapes: true,
            rewriteShapeState: true,
        });

        expect(materializePdfJsDocumentForInternalUse).not.toHaveBeenCalled();
        expect(serializePdfForSave).toHaveBeenCalledWith(sourceBytes, {
            annotationCommentsSnapshot,
            pendingTexts,
            pendingDeletes: [],
            includeShapes: true,
            rewriteShapeState: true,
            forceRewrite: true,
        });
        expect(result.source).toBe('serialized-rewrite');
        expect(result.baseBytes).toBe(sourceBytes);
        expect(result.serializedBytes).toBe(finalBytes);
        expect(result.serializedResult).toEqual({
            finalBytes,
            saveMode: 'save_as_rewrite',
            source: 'serialized-rewrite',
        });
    });
});
