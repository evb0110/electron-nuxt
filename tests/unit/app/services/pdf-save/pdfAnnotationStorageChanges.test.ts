import {
    describe,
    expect,
    it,
} from 'vitest';
import { collectLivePdfJsAnnotationChangeIds } from '@app/services/pdf-save/pdfAnnotationStorageChanges';

describe('collectLivePdfJsAnnotationChangeIds', () => {
    it('ignores editor-only annotations that were deleted before PDF.js materialization', () => {
        const serializableMap = new Map([[
            'pdfjs_internal_editor_0',
            { deleted: true },
        ]]);
        const document = {annotationStorage: {
            serializable: { map: serializableMap },
            modifiedIds: { ids: new Set(['pdfjs_internal_editor_0']) },
        }} as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.ids).toEqual(new Set());
        expect(result.hasChanges).toBe(false);
        expect(result.hasUnknownChanges).toBe(false);
    });

    it('refreshes stale PDF.js modified ids before reading live changes', () => {
        const storage = {
            serializable: { map: new Map() },
            modifiedIds: { ids: new Set(['pdfjs_internal_editor_0']) },
            resetModifiedIds() {
                this.modifiedIds = { ids: new Set() };
            },
        };
        const document = { annotationStorage: storage } as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.ids).toEqual(new Set());
        expect(result.hasChanges).toBe(false);
        expect(result.hasUnknownChanges).toBe(false);
    });

    it('keeps deleted existing PDF annotations as live changes', () => {
        const serializableMap = new Map([[
            'pdfjs_internal_editor_1',
            {
                deleted: true,
                annotationId: '3856R',
            },
        ]]);
        const document = {annotationStorage: {
            serializable: { map: serializableMap },
            modifiedIds: { ids: new Set(['pdfjs_internal_editor_1']) },
        }} as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.ids).toEqual(new Set(['3856R']));
        expect(result.hasChanges).toBe(true);
        expect(result.hasUnknownChanges).toBe(false);
    });

    it('treats PDF.js annotation storage inspection failures as unknown live changes', () => {
        const document = { annotationStorage: {resetModifiedIds() {
            throw new Error('pdfjs storage unavailable');
        }}} as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.ids).toEqual(new Set());
        expect(result.hasChanges).toBe(true);
        expect(result.hasUnknownChanges).toBe(true);
    });

    it('treats serializable getter failures as unknown live changes', () => {
        const document = { annotationStorage: {get serializable() {
            throw new Error('pdfjs serialization failed');
        }}} as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.ids).toEqual(new Set());
        expect(result.hasChanges).toBe(true);
        expect(result.hasUnknownChanges).toBe(true);
    });
});
