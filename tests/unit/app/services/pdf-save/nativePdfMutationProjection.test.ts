import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import {
    buildNativeFreeTextNotesForSave,
    isReplayableEditorOnlyFreeTextNote,
    toNativeFreeTextNote,
} from '@app/modules/pdf-viewer/runtime/save/nativeFreeTextNotes';
import { buildNativeNoteTextUpdatesForSave } from '@app/modules/pdf-viewer/runtime/save/nativeNoteTextUpdates';
import { buildNativeAnnotationDeletesForSave } from '@app/modules/pdf-viewer/runtime/save/buildNativeAnnotationDeletesForSave';
import {
    buildNativeShapesMutationForSave,
    isNativeShapeEligible,
    toNativeShapeAnnotation,
} from '@app/modules/pdf-viewer/runtime/save/nativeShapeMutations';
import {
    buildNativeMarkupMutationForSave,
    toNativeMarkupHint,
} from '@app/modules/pdf-viewer/runtime/save/nativeMarkupMutations';

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'ann-1',
        stableKey: 'ann:0:12R0',
        sortIndex: null,
        pageIndex: 0,
        pageNumber: 1,
        text: 'Original note',
        kindLabel: 'Note',
        subtype: 'Text',
        author: 'Tester',
        createdAt: 1781009077123,
        modifiedAt: null,
        color: '#ffcc00',
        uid: null,
        annotationId: '12R0',
        source: 'pdf',
        hasNote: true,
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.01,
            height: 0.01,
        },
        ...overrides,
    };
}

function createEditorFreeTextComment(overrides: Partial<IAnnotationCommentSummary> = {}) {
    return createComment({
        id: 'editor:0:pdfjs_internal_editor_0',
        stableKey: 'uid:0:pdfjs_internal_editor_0',
        text: 'Editor note',
        subtype: 'FreeText',
        annotationId: null,
        uid: null,
        source: 'editor',
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.2,
            height: 0.2,
        },
        ...overrides,
    });
}

function createShape(overrides: Partial<IShapeAnnotation> = {}): IShapeAnnotation {
    return {
        id: 'shape-1',
        type: 'rectangle',
        pageIndex: 0,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
        color: '#00aaff',
        opacity: 0.75,
        strokeWidth: 2,
        annotationId: '22R0',
        stableKey: 'ann:0:22R0',
        pdfSubtype: 'Square',
        createdAt: 1781009077123,
        modifiedAt: 1781009077999,
        ...overrides,
    };
}

function createMutationProjectionInput(overrides: Partial<{
    canonicalComments: IAnnotationCommentSummary[];
    pendingTexts: Map<string, string>;
    pendingDeletes: IAnnotationCommentSummary[];
}> = {}) {
    return {
        pendingTexts: new Map(),
        pendingDeletes: [],
        canonicalComments: [],
        ...overrides,
    };
}

describe('native FreeText note builders', () => {
    it('detects replayable editor-only FreeText notes and normalizes native note payloads', () => {
        const comment = createEditorFreeTextComment();

        expect(isReplayableEditorOnlyFreeTextNote(comment)).toBe(true);
        expect(toNativeFreeTextNote(comment)).toEqual({
            pageIndex: 0,
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            text: 'Editor note',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.0016,
                height: 0.0016,
            },
            author: 'Tester',
            color: '#ffcc00',
            createdAt: 1781009077123,
        });
    });

    it('deduplicates native FreeText notes by stable key', () => {
        const comment = createEditorFreeTextComment();

        const notes = buildNativeFreeTextNotesForSave(createMutationProjectionInput({canonicalComments: [
            comment,
            createEditorFreeTextComment(),
        ]}));

        expect(notes.value).toEqual([expect.objectContaining({stableKey: comment.stableKey})]);
        expect(notes.skipEvents).toEqual([]);
    });
});

describe('native note text and delete builders', () => {
    it('builds native text updates for PDF-sourced note refs', () => {
        const pendingTexts = new Map([[
            'ann:0:12R0',
            'Updated note',
        ]]);

        const updates = buildNativeNoteTextUpdatesForSave(createMutationProjectionInput({
            pendingTexts,
            canonicalComments: [createComment()],
        }));

        expect(updates.value).toEqual([{
            objectNumber: 12,
            generationNumber: 0,
            text: 'Updated note',
        }]);
        expect(updates.skipEvents).toEqual([]);
    });

    it('skips PDF-backed FreeText text updates so full serialization preserves rect and AP invariants', () => {
        const pendingTexts = new Map([[
            'ann:0:12R0',
            'Updated note',
        ]]);

        const updates = buildNativeNoteTextUpdatesForSave(createMutationProjectionInput({
            pendingTexts,
            canonicalComments: [createComment({subtype: 'FreeText'})],
        }));

        expect(updates.value).toBeNull();
        expect(updates.skipEvents).toEqual([{
            event: 'Skipped native note-text save fast path',
            reason: 'pending-text-not-native-eligible',
            details: expect.objectContaining({
                stableKey: 'ann:0:12R0',
                subtype: 'FreeText',
                targetRef: {
                    objectNumber: 12,
                    generationNumber: 0,
                },
            }),
        }]);
    });

    it('builds native deletes for PDF refs and editor-only FreeText stable keys', () => {
        const deletes = buildNativeAnnotationDeletesForSave(createMutationProjectionInput({pendingDeletes: [
            createComment(),
            createEditorFreeTextComment(),
        ]}));

        expect(deletes.value).toEqual([
            {
                pageIndex: 0,
                objectNumber: 12,
                generationNumber: 0,
            },
            {
                pageIndex: 0,
                stableKey: 'uid:0:pdfjs_internal_editor_0',
                createdAt: 1781009077123,
            },
        ]);
        expect(deletes.skipEvents).toEqual([]);
    });
});

describe('native shape builders', () => {
    it('maps eligible shapes to native payloads with copied point arrays', () => {
        const shape = createShape({
            type: 'polyline',
            pdfSubtype: 'PolyLine',
            points: [
                {
                    x: 0.1,
                    y: 0.2,
                },
                {
                    x: 0.3,
                    y: 0.4,
                },
            ],
        });

        expect(isNativeShapeEligible(shape, 2)).toBe(true);
        const nativeShape = toNativeShapeAnnotation(shape);

        expect(nativeShape).toEqual(expect.objectContaining({
            id: 'shape-1',
            type: 'polyline',
            annotationId: '22R',
            stableKey: 'ann:0:22R0',
            pdfSubtype: 'PolyLine',
        }));
        expect(nativeShape.points).toEqual(shape.points);
        expect(nativeShape.points).not.toBe(shape.points);
    });

    it('returns null when any dirty shape is not native-eligible', () => {
        const mutation = buildNativeShapesMutationForSave({
            shapeStateDirty: true,
            rewriteShapeState: true,
            totalPageCount: 1,
            shapes: [
                createShape(),
                createShape({
                    x: 0.9,
                    width: 0.2,
                }),
            ],
            deletedAnnotationIds: [],
            deletedStableKeys: [],
        });

        expect(mutation).toBeNull();
    });
});

describe('native markup builders', () => {
    it('converts eligible markup hints and edited comment hints', () => {
        const markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        };

        expect(toNativeMarkupHint({
            subtype: 'Highlight',
            pageIndex: 0,
            markerRect,
            annotationId: '44R0',
            color: '#ffee00',
            id: 'hint-1',
            pageMarkupIndex: 3,
            source: 'editor',
            consumed: false,
        })).toEqual({
            subtype: 'Highlight',
            pageIndex: 0,
            markerRect,
            annotationId: '44R0',
            color: '#ffee00',
            id: 'hint-1',
            pageMarkupIndex: 3,
            source: 'editor',
        });

        const mutation = buildNativeMarkupMutationForSave({
            canonicalComments: [
                createComment({
                    stableKey: 'ann:0:44R0',
                    subtype: 'Highlight',
                    color: '#ffee00',
                    colorEdited: true,
                    annotationId: '44R0',
                    markerRect,
                }),
                createComment({
                    stableKey: 'ann:0:45R0',
                    subtype: 'Squiggly',
                    annotationId: '45R0',
                    markerRect,
                }),
            ],
            annotationWorkDirty: true,
            markupSubtypeOverrides: new Map<string, TMarkupSubtype>([[
                ' 44R0 ',
                'Underline',
            ]]),
            markupSubtypeHints: [{
                subtype: 'Squiggly',
                pageIndex: 0,
                markerRect,
                annotationId: '45R0',
                color: null,
                id: null,
                pageMarkupIndex: null,
                source: null,
                consumed: false,
            }],
        });

        expect(mutation?.overrides).toEqual([[
            '44R0',
            'Underline',
        ]]);
        expect(mutation?.hints).toEqual([
            expect.objectContaining({
                subtype: 'Squiggly',
                annotationId: '45R0',
            }),
            expect.objectContaining({
                subtype: 'Highlight',
                annotationId: '44R0',
            }),
        ]);
    });

    it('drops stale markup hints and overrides that no longer match current markup comments', () => {
        const markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        };

        const mutation = buildNativeMarkupMutationForSave({
            canonicalComments: [createComment()],
            annotationWorkDirty: true,
            markupSubtypeOverrides: new Map<string, TMarkupSubtype>([[
                '44R0',
                'Underline',
            ]]),
            markupSubtypeHints: [{
                subtype: 'Squiggly',
                pageIndex: 0,
                markerRect,
                annotationId: '45R0',
                color: null,
                id: null,
                pageMarkupIndex: null,
                source: null,
                consumed: false,
            }],
        });

        expect(mutation).toBeNull();
    });
});
