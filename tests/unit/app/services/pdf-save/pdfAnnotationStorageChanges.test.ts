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

    it('captures the recorded PDF.js FreeText box as an exact native mutation', () => {
        const serializableMap = new Map([[
            'pdfjs_internal_editor_0',
            {
                annotationType: 3,
                pageIndex: 854,
                rect: [
                    2.048192,
                    554.41672,
                    59.34848,
                    580.43896,
                ],
                rotation: 0,
                popupRef: '',
                color: [
                    245,
                    158,
                    11,
                ],
                fontSize: 16,
                value: 'asdfadf',
                id: null,
            },
        ]]);
        const document = {annotationStorage: {
            serializable: {
                map: serializableMap,
                hash: 'recorded-large-pdf-free-text-box',
            },
            modifiedIds: { ids: new Set([null]) },
        }} as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.nativeFreeTextEditors).toEqual(new Map([[
            'pdfjs_internal_editor_0',
            {
                pageIndex: 854,
                stableKey: expect.stringMatching(/^freetext-[0-9a-f-]{36}$/u),
                text: 'asdfadf',
                rect: [
                    2.048192,
                    554.41672,
                    59.34848,
                    580.43896,
                ],
                rotation: 0,
                fontSize: 16,
                color: [
                    245,
                    158,
                    11,
                ],
            },
        ]]));
        expect(result.ids).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.replayableEditorNoteIds).toEqual(new Set());
        expect(result.hasUnknownChanges).toBe(false);
    });

    it('assigns a new app-owned FreeText identity after document reopen', () => {
        const editor = {
            annotationType: 3,
            pageIndex: 0,
            rect: [
                20,
                30,
                180,
                60,
            ],
            rotation: 0,
            color: [
                0,
                0,
                0,
            ],
            fontSize: 16,
            value: 'saved text',
            id: null,
        };
        const createDocument = () => ({annotationStorage: {
            serializable: {map: new Map([[
                'pdfjs_internal_editor_0',
                editor,
            ]])},
            modifiedIds: {ids: new Set([null])},
        }}) as never;
        const firstDocument = createDocument();
        const reopenedDocument = createDocument();

        const first = collectLivePdfJsAnnotationChangeIds(firstDocument)
            .nativeFreeTextEditors.get('pdfjs_internal_editor_0');
        const repeated = collectLivePdfJsAnnotationChangeIds(firstDocument)
            .nativeFreeTextEditors.get('pdfjs_internal_editor_0');
        const reopened = collectLivePdfJsAnnotationChangeIds(reopenedDocument)
            .nativeFreeTextEditors.get('pdfjs_internal_editor_0');

        expect(first?.stableKey).toMatch(/^freetext-[0-9a-f-]{36}$/u);
        expect(repeated?.stableKey).toBe(first?.stableKey);
        expect(reopened?.stableKey).not.toBe(first?.stableKey);
    });

    it('ignores a blank editor-only FreeText placeholder beside a saveable text box', () => {
        const document = {annotationStorage: {
            serializable: {map: new Map([
                [
                    'pdfjs_internal_editor_0',
                    {
                        annotationType: 3,
                        pageIndex: 0,
                        value: '\u200B',
                        id: null,
                    },
                ],
                [
                    'pdfjs_internal_editor_1',
                    {
                        annotationType: 3,
                        pageIndex: 0,
                        rect: [
                            20,
                            30,
                            180,
                            60,
                        ],
                        rotation: 0,
                        color: [
                            0,
                            0,
                            0,
                        ],
                        fontSize: 16,
                        value: 'saved text',
                        id: null,
                    },
                ],
            ])},
            modifiedIds: {ids: new Set([null])},
        }} as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.ids).toEqual(new Set(['pdfjs_internal_editor_1']));
        expect(result.nativeFreeTextEditors).toEqual(new Map([[
            'pdfjs_internal_editor_1',
            expect.objectContaining({text: 'saved text'}),
        ]]));
        expect(result.hasChanges).toBe(true);
        expect(result.hasUnknownChanges).toBe(false);
    });

    it('keeps Unicode FreeText boxes on the PDF.js materialization route', () => {
        const serializableMap = new Map([[
            'pdfjs_internal_editor_0',
            {
                annotationType: 3,
                pageIndex: 0,
                rect: [
                    20,
                    30,
                    180,
                    60,
                ],
                rotation: 0,
                color: [
                    0,
                    0,
                    0,
                ],
                fontSize: 16,
                value: 'Привет',
                id: null,
            },
        ]]);
        const document = {annotationStorage: {
            serializable: {map: serializableMap},
            modifiedIds: {ids: new Set([null])},
        }} as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.ids).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.nativeFreeTextEditors).toEqual(new Map());
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
