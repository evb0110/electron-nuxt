import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    collectLivePdfJsAnnotationChangeIds,
    resetLivePdfJsAnnotationStorageModifiedIds,
    resetLivePdfJsAnnotationStorageModifiedState,
} from '@app/modules/pdf-viewer/runtime/save/pdfAnnotationStorageChanges';

describe('collectLivePdfJsAnnotationChangeIds', () => {
    it('exposes named bridge helpers for PDF.js annotation storage resets', () => {
        let resetModifiedCalls = 0;
        let resetModifiedIdsCalls = 0;
        const document = { annotationStorage: {
            resetModified() {
                resetModifiedCalls += 1;
            },
            resetModifiedIds() {
                resetModifiedIdsCalls += 1;
            },
        }} as never;

        expect(resetLivePdfJsAnnotationStorageModifiedState(document)).toBe(true);
        expect(resetLivePdfJsAnnotationStorageModifiedIds(document)).toBe(true);

        expect(resetModifiedCalls).toBe(1);
        expect(resetModifiedIdsCalls).toBe(1);
    });

    it('treats missing PDF.js annotation storage reset methods as no-ops', () => {
        expect(resetLivePdfJsAnnotationStorageModifiedState({ annotationStorage: {} } as never)).toBe(false);
        expect(resetLivePdfJsAnnotationStorageModifiedIds(null)).toBe(false);
    });

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

    it('marks PDF.js FreeText popup editor storage as replayable note work', () => {
        const serializableMap = new Map([[
            'pdfjs_internal_editor_0',
            {
                annotationType: 3,
                pageIndex: 0,
                value: '',
                popup: {
                    contents: 'note body',
                    deleted: false,
                },
            },
        ]]);
        const document = {annotationStorage: {
            serializable: { map: serializableMap },
            modifiedIds: { ids: new Set(['pdfjs_internal_editor_0']) },
        }} as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.ids).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.replayableEditorNoteIds).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.hasChanges).toBe(true);
        expect(result.hasUnknownChanges).toBe(false);
    });

    it('marks blank PDF.js FreeText editor storage as replayable note work', () => {
        const serializableMap = new Map([[
            'pdfjs_internal_editor_0',
            {
                annotationType: 3,
                pageIndex: 0,
                value: '',
            },
        ]]);
        const document = {annotationStorage: {
            serializable: { map: serializableMap },
            modifiedIds: { ids: new Set(['pdfjs_internal_editor_0']) },
        }} as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.ids).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.replayableEditorNoteIds).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.hasChanges).toBe(true);
        expect(result.hasUnknownChanges).toBe(false);
    });

    it('marks zero-width-only PDF.js FreeText editor storage as replayable note work', () => {
        const serializableMap = new Map([[
            'pdfjs_internal_editor_0',
            {
                annotationType: 3,
                pageIndex: 0,
                value: '\u200B',
            },
        ]]);
        const document = {annotationStorage: {
            serializable: { map: serializableMap },
            modifiedIds: { ids: new Set(['pdfjs_internal_editor_0']) },
        }} as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.ids).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.replayableEditorNoteIds).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.hasChanges).toBe(true);
        expect(result.hasUnknownChanges).toBe(false);
    });

    it('marks string-typed FreeText editor storage as replayable note work', () => {
        const serializableMap = new Map([[
            'pdfjs_internal_editor_0',
            {
                annotationType: 'freetext',
                pageIndex: 0,
                value: '',
            },
        ]]);
        const document = {annotationStorage: {
            serializable: { map: serializableMap },
            modifiedIds: { ids: new Set(['pdfjs_internal_editor_0']) },
        }} as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.ids).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.replayableEditorNoteIds).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.hasChanges).toBe(true);
        expect(result.hasUnknownChanges).toBe(false);
    });

    it('marks PDF.js FreeText editor comment payload as replayable note work', () => {
        const serializableMap = new Map([[
            'pdfjs_internal_editor_0',
            {
                annotationType: 3,
                pageIndex: 0,
                value: 'visible typewriter text',
                comment: {
                    text: 'note body',
                    deleted: false,
                },
            },
        ]]);
        const document = {annotationStorage: {
            serializable: { map: serializableMap },
            modifiedIds: { ids: new Set(['pdfjs_internal_editor_0']) },
        }} as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.ids).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.replayableEditorNoteIds).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.hasChanges).toBe(true);
        expect(result.hasUnknownChanges).toBe(false);
    });

    it('ignores nullish PDF.js modified ids for brand-new editor annotations', () => {
        const serializableMap = new Map([[
            'pdfjs_internal_editor_0',
            {
                annotationType: 3,
                pageIndex: 0,
                value: '',
                popup: {
                    contents: 'note body',
                    deleted: false,
                },
            },
        ]]);
        const document = {annotationStorage: {
            serializable: { map: serializableMap },
            modifiedIds: { ids: new Set([undefined]) },
        }} as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.ids).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.replayableEditorNoteIds).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.hasChanges).toBe(true);
        expect(result.hasUnknownChanges).toBe(false);
    });

    it('does not mark regular FreeText editor storage without a popup as replayable note work', () => {
        const serializableMap = new Map([[
            'pdfjs_internal_editor_0',
            {
                annotationType: 3,
                pageIndex: 0,
                value: 'visible typewriter text',
            },
        ]]);
        const document = {annotationStorage: {
            serializable: { map: serializableMap },
            modifiedIds: { ids: new Set(['pdfjs_internal_editor_0']) },
        }} as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.ids).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.replayableEditorNoteIds).toEqual(new Set());
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
