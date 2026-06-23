import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { serializePrintableSourceData } from '@app/modules/workspace-shell/serialization/serializePrintableSourceData';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

function createEmbeddedDelete(): IAnnotationCommentSummary {
    return {
        id: '3856R',
        stableKey: 'ann:0:3856R',
        sortIndex: null,
        pageIndex: 0,
        pageNumber: 1,
        annotationId: '3856R',
        uid: '3856R',
        author: null,
        color: null,
        text: 'Deleted embedded note',
        source: 'pdf',
        opacity: null,
        subtype: 'FreeText',
        createdAt: null,
        modifiedAt: null,
    };
}

describe('serializePrintableSourceData', () => {
    it('serializes print bytes with pending embedded annotation text updates and deletes', async () => {
        const source = Uint8Array.of(1, 2, 3);
        const serialized = Uint8Array.of(4, 5, 6);
        const pendingTexts = new Map([[
            'ann:0:3856R',
            'Updated note text',
        ]]);
        const pendingDeletes = [createEmbeddedDelete()];
        const serializePdfForSave = vi.fn(async () => serialized);
        const restorePendingEmbeddedTextUpdates = vi.fn();
        const restorePendingEmbeddedAnnotationDeletes = vi.fn();

        const result = await serializePrintableSourceData(source, {
            serializePdfForSave,
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            restorePendingEmbeddedTextUpdates,
            consumePendingEmbeddedAnnotationDeletes: vi.fn(() => pendingDeletes),
            restorePendingEmbeddedAnnotationDeletes,
        });

        expect(result).toBe(serialized);
        expect(serializePdfForSave).toHaveBeenCalledWith(source, {
            includeShapes: true,
            rewriteShapeState: true,
            pendingTexts,
            pendingDeletes,
        });
        expect(restorePendingEmbeddedTextUpdates).toHaveBeenCalledWith(pendingTexts);
        expect(restorePendingEmbeddedAnnotationDeletes).toHaveBeenCalledWith(pendingDeletes);
    });

    it('restores consumed embedded annotation changes when print serialization fails', async () => {
        const pendingTexts = new Map([[
            'ann:0:3856R',
            'Updated note text',
        ]]);
        const pendingDeletes = [createEmbeddedDelete()];
        const restorePendingEmbeddedTextUpdates = vi.fn();
        const restorePendingEmbeddedAnnotationDeletes = vi.fn();

        await expect(serializePrintableSourceData(Uint8Array.of(1), {
            serializePdfForSave: vi.fn(async () => {
                throw new Error('serialize failed');
            }),
            consumePendingEmbeddedTextUpdates: vi.fn(() => pendingTexts),
            restorePendingEmbeddedTextUpdates,
            consumePendingEmbeddedAnnotationDeletes: vi.fn(() => pendingDeletes),
            restorePendingEmbeddedAnnotationDeletes,
        })).rejects.toThrow('serialize failed');

        expect(restorePendingEmbeddedTextUpdates).toHaveBeenCalledWith(pendingTexts);
        expect(restorePendingEmbeddedAnnotationDeletes).toHaveBeenCalledWith(pendingDeletes);
    });
});
