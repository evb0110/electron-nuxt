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
});
