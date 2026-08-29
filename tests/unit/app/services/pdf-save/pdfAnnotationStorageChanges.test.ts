import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    collectLivePdfJsAnnotationChangeIds,
    normalizeLivePdfJsAnnotationChangesAgainstSavedFingerprint,
    resetLivePdfJsAnnotationStorageModifiedIds,
    resetLivePdfJsAnnotationStorageModifiedState,
} from '@app/modules/pdf-viewer/runtime/save/pdfAnnotationStorageChanges';
import { AnnotationStore } from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import { asAnnotationId } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { getPdfjsEditorFacadeState } from '@app/modules/pdf-viewer/engine/annotations/bridge/getPdfjsEditorFacadeState';
import type { IPdfNativeFreeTextEditor } from '@contracts/electronApiDocuments';
import { requirePageIndex } from '@contracts/pageNumbers';

const MARKER_RECT = {
    left: 0.1,
    top: 0.2,
    width: 0.02,
    height: 0.02,
};

function createPersistedCommentMarkerAnchorFixture() {
    const editorKey = 'pdfjs_internal_editor_0';
    const anchorEditor = {};
    Object.assign(getPdfjsEditorFacadeState(anchorEditor), {
        canonicalAnnotationId: 'note-1',
        commentMarkerAnchor: true,
        pendingAnchorRect: MARKER_RECT,
    });
    const annotationStore = new AnnotationStore();
    annotationStore.import({
        kind: 'sticky-note',
        identity: {
            id: asAnnotationId('note-1'),
            elementId: editorKey,
            pdfRef: '12R',
        },
        pageIndex: 0,
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: 1_781_000_000_000,
        modifiedAt: null,
        author: 'Tester',
        text: 'text-note-1',
        anchor: MARKER_RECT,
        color: '#f59e0b',
    });
    const serializedAnchor = {
        annotationType: 3,
        pageIndex: 0,
        value: '\u200B',
        rect: [
            20,
            30,
            36,
            46,
        ],
        rotation: 0,
        color: [
            245,
            158,
            11,
        ],
        fontSize: 16,
        popup: {
            contents: 'text-note-1',
            deleted: false,
            rect: [
                0,
                0,
                1,
                1,
            ],
        },
    };
    const serializableMap = new Map<string, unknown>([[
        editorKey,
        serializedAnchor,
    ]]);
    const serializable = {
        hash: 'persisted-anchor-hash',
        map: serializableMap,
    };
    const document = {annotationStorage: {
        serializable,
        modifiedIds: {ids: new Set()},
        getRawValue: (key: string) => key === editorKey ? anchorEditor : undefined,
    }} as never;
    return {
        anchorEditor,
        annotationStore,
        document,
        serializable,
        serializableMap,
        serializedAnchor,
    };
}

describe('collectLivePdfJsAnnotationChangeIds', () => {
    it('normalizes a known exact saved fingerprint to no live work', () => {
        const pendingEditor: IPdfNativeFreeTextEditor = {
            pageIndex: requirePageIndex(0),
            stableKey: 'pdfjs_internal_editor_0',
            text: 'Saved editor',
            rect: [
                10,
                20,
                110,
                60,
            ],
            rotation: 0,
            fontSize: 16,
            color: [
                245,
                158,
                11,
            ],
        };
        const summary = {
            ids: new Set(['pdfjs_internal_editor_0']),
            replayableEditorNoteIds: new Set(['pdfjs_internal_editor_0']),
            nativeFreeTextEditors: new Map([[
                'pdfjs_internal_editor_0',
                pendingEditor,
            ]]),
            hasChanges: true,
            hasUnknownChanges: false,
            fingerprint: 'saved-fingerprint',
        };

        expect(normalizeLivePdfJsAnnotationChangesAgainstSavedFingerprint(
            summary,
            'saved-fingerprint',
        )).toMatchObject({
            ids: new Set(),
            replayableEditorNoteIds: new Set(),
            nativeFreeTextEditors: new Map(),
            hasChanges: false,
            hasUnknownChanges: false,
            fingerprint: 'empty',
        });
    });

    it('keeps changed and unknown storage fail-closed against a saved fingerprint', () => {
        const changed = {
            ids: new Set(['pdfjs_internal_editor_0']),
            replayableEditorNoteIds: new Set<string>(),
            nativeFreeTextEditors: new Map(),
            hasChanges: true,
            hasUnknownChanges: false,
            fingerprint: 'changed-fingerprint',
        };
        const unknown = {
            ...changed,
            hasUnknownChanges: true,
            fingerprint: 'unknown',
        };

        expect(normalizeLivePdfJsAnnotationChangesAgainstSavedFingerprint(
            changed,
            'saved-fingerprint',
        )).toBe(changed);
        expect(normalizeLivePdfJsAnnotationChangesAgainstSavedFingerprint(
            unknown,
            'unknown',
        )).toBe(unknown);
    });

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

    it('does not count a persisted unchanged comment marker anchor as live PDF.js work', () => {
        const {
            annotationStore,
            document,
        } = createPersistedCommentMarkerAnchorFixture();

        const result = collectLivePdfJsAnnotationChangeIds(document, {annotationStore});

        expect(result.ids).toEqual(new Set());
        expect(result.hasChanges).toBe(false);
        expect(result.hasUnknownChanges).toBe(false);
        expect(result.fingerprint).toBe('empty');
    });

    it('counts a moved persisted comment marker anchor as live PDF.js work', () => {
        const fixture = createPersistedCommentMarkerAnchorFixture();
        getPdfjsEditorFacadeState(fixture.anchorEditor).pendingAnchorRect = {
            ...MARKER_RECT,
            left: MARKER_RECT.left + 0.01,
        };

        const result = collectLivePdfJsAnnotationChangeIds(
            fixture.document,
            {annotationStore: fixture.annotationStore},
        );

        expect(result.ids).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.hasChanges).toBe(true);
    });

    it('counts changed comment marker text as live PDF.js work', () => {
        const fixture = createPersistedCommentMarkerAnchorFixture();
        fixture.serializedAnchor.popup.contents = 'changed note text';

        const result = collectLivePdfJsAnnotationChangeIds(
            fixture.document,
            {annotationStore: fixture.annotationStore},
        );

        expect(result.ids).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.hasChanges).toBe(true);
    });

    it('counts a canonically dirty comment marker anchor as live PDF.js work', () => {
        const fixture = createPersistedCommentMarkerAnchorFixture();
        fixture.annotationStore.moveAnchor(asAnnotationId('note-1'), {
            ...MARKER_RECT,
            left: MARKER_RECT.left + 0.01,
        });

        const result = collectLivePdfJsAnnotationChangeIds(
            fixture.document,
            {annotationStore: fixture.annotationStore},
        );

        expect(result.ids).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.hasChanges).toBe(true);
    });

    it('counts a deleted canonical comment marker anchor as live PDF.js work', () => {
        const fixture = createPersistedCommentMarkerAnchorFixture();
        fixture.annotationStore.delete(asAnnotationId('note-1'));

        const result = collectLivePdfJsAnnotationChangeIds(
            fixture.document,
            {annotationStore: fixture.annotationStore},
        );

        expect(result.ids).toEqual(new Set(['pdfjs_internal_editor_0']));
        expect(result.hasChanges).toBe(true);
    });

    it('keeps excluded comment marker anchor metadata out of the live-change fingerprint', () => {
        const fixture = createPersistedCommentMarkerAnchorFixture();
        fixture.serializableMap.set('pdfjs_internal_editor_1', {
            annotationType: 3,
            pageIndex: 0,
            value: 'ordinary FreeText',
            rect: [
                40,
                50,
                140,
                80,
            ],
            rotation: 0,
            color: [
                0,
                0,
                0,
            ],
            fontSize: 14,
        });
        const first = collectLivePdfJsAnnotationChangeIds(
            fixture.document,
            {annotationStore: fixture.annotationStore},
        );

        Object.assign(fixture.serializedAnchor.popup, {date: '2026-08-27T21:00:00Z'});
        fixture.serializable.hash = 'changed-only-by-excluded-anchor';
        const second = collectLivePdfJsAnnotationChangeIds(
            fixture.document,
            {annotationStore: fixture.annotationStore},
        );

        expect(first.ids).toEqual(new Set(['pdfjs_internal_editor_1']));
        expect(second.ids).toEqual(first.ids);
        expect(second.fingerprint).toBe(first.fingerprint);
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

    it('captures an edited imported FreeText box by its existing PDF identity', () => {
        const document = {annotationStorage: {
            serializable: {map: new Map([[
                'pdfjs_internal_editor_4',
                {
                    annotationType: 3,
                    annotationId: '44R',
                    pageIndex: 7,
                    rect: [
                        20,
                        30,
                        180,
                        80,
                    ],
                    rotation: 0,
                    color: [
                        17,
                        24,
                        39,
                    ],
                    fontSize: 18,
                    value: 'edited imported text',
                },
            ]])},
            modifiedIds: {ids: new Set(['pdfjs_internal_editor_4'])},
        }} as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.ids).toEqual(new Set(['44R']));
        expect(result.nativeFreeTextEditors).toEqual(new Map([[
            '44R',
            expect.objectContaining({
                annotationId: '44R',
                pageIndex: 7,
                text: 'edited imported text',
                rect: [
                    20,
                    30,
                    180,
                    80,
                ],
            }),
        ]]));
        expect(result.hasUnknownChanges).toBe(false);
    });

    it('removes PDF.js invisible placeholders from a native FreeText mutation', () => {
        const document = {annotationStorage: {
            serializable: {map: new Map([[
                'pdfjs_internal_editor_2',
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
                        17,
                        24,
                        39,
                    ],
                    fontSize: 22,
                    value: '\u200Bsecond editor\uFEFF',
                    id: null,
                },
            ]])},
            modifiedIds: {ids: new Set([null])},
        }} as never;

        const result = collectLivePdfJsAnnotationChangeIds(document);

        expect(result.nativeFreeTextEditors.get('pdfjs_internal_editor_2')).toEqual(expect.objectContaining({text: 'second editor'}));
        expect(result.ids).toEqual(new Set(['pdfjs_internal_editor_2']));
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
