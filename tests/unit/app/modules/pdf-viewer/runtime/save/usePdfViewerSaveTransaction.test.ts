import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfViewerSaveTransaction } from '@app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction';
import {requireDocumentRevisionToken} from '@contracts';
import {buildSerializationPlan} from '@app/modules/pdf-viewer/serialization/serializationPlan';

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
        expect(result.nativeMutationProjection).toBeNull();
        expect(result.annotationSavePlan).toMatchObject({
            route: 'source-clean',
            reason: 'no-live-pdfjs-annotation-work',
        });
    });

    it('carries the canonical save frontier verification and commit callbacks', async () => {
        const verify = vi.fn(async () => undefined);
        const commit = vi.fn();
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            materializePdfJsDocumentForInternalUse: vi.fn(async () => new Uint8Array([1])),
            prepareAnnotationSave: () => ({
                verify,
                commit,
            }),
        });

        const result = await runSaveTransaction({mode: 'persist'});
        await result.verifyAnnotationSave?.(new Uint8Array([2]));
        result.commitAnnotationSave?.();

        expect(verify).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenCalledOnce();
    });

    it('plans exclusively from the captured canonical frontier without rereading live PDF.js storage', async () => {
        const getPdfDocument = vi.fn(() => {
            throw new Error('live storage must not be read after frontier capture');
        });
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            materializePdfJsDocumentForInternalUse: vi.fn(async () => new Uint8Array([1])),
            getPdfDocument,
            prepareAnnotationSave: () => ({
                plan: buildSerializationPlan({
                    epoch: 7,
                    entityBaselineHash: 'baseline',
                    documentRevisionToken: requireDocumentRevisionToken('revision-7'),
                    revisions: new Map(),
                }, []),
                verify: vi.fn(async () => undefined),
                commit: vi.fn(),
            }),
        });

        await expect(runSaveTransaction({mode: 'persist'})).resolves.toMatchObject({annotationSavePlan: {route: 'source-clean'}});
        expect(getPdfDocument).not.toHaveBeenCalled();
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
        const getSourcePdfData = vi.fn(async () => sourceBytes);
        const serializePdfForSave = vi.fn(async () => finalBytes);
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => new Uint8Array([9]));
        const { runSaveTransaction } = usePdfViewerSaveTransaction({materializePdfJsDocumentForInternalUse});

        const result = await runSaveTransaction({
            mode: 'persist',
            saveMode: 'save_as_rewrite',
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
        expect(serializePdfForSave).toHaveBeenCalledWith(sourceBytes, expect.objectContaining({
            includeShapes: true,
            rewriteShapeState: true,
            forceRewrite: true,
            annotationSerializationPlan: expect.objectContaining({
                sourceEpoch: 0,
                mutationOrder: expect.any(Array),
            }),
        }));
        expect(result.source).toBe('serialized-rewrite');
        expect(result.baseBytes).toBe(sourceBytes);
        expect(result.serializedBytes).toBe(finalBytes);
        expect(result.serializedResult).toEqual({
            finalBytes,
            saveMode: 'save_as_rewrite',
            source: 'serialized-rewrite',
            changedObjectRefs: [],
        });
    });
});
