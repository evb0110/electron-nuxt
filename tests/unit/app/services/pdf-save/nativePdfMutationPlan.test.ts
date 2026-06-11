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
} from '@app/services/pdf-save/nativeFreeTextNotes';
import { buildNativeNoteTextUpdatesForSave } from '@app/services/pdf-save/nativeNoteTextUpdates';
import { buildNativeAnnotationDeletesForSave } from '@app/services/pdf-save/buildNativeAnnotationDeletesForSave';
import {
    buildNativeShapesMutationForSave,
    isNativeShapeEligible,
    toNativeShapeAnnotation,
} from '@app/services/pdf-save/nativeShapeMutations';
import {
    buildNativeMarkupMutationForSave,
    toNativeMarkupHint,
} from '@app/services/pdf-save/nativeMarkupMutations';
import { buildNativePdfMutationPlanForSave } from '@app/services/pdf-save/buildNativePdfMutationPlanForSave';
import type { INativePdfMutationPlanInput } from '@app/services/pdf-save/nativePdfMutationPlanTypes';

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

function createMutationPlanInput(overrides: Partial<INativePdfMutationPlanInput> = {}): INativePdfMutationPlanInput {
    return {
        mode: 'save',
        pendingTexts: null,
        pendingDeletes: null,
        annotationCommentsSnapshot: [],
        shapeStateDirty: false,
        forcePdfjsMaterialize: false,
        savedPdfjsAnnotationBaselineDirty: false,
        includeManagedShapesForLiveSource: false,
        forceRewrite: false,
        pageLabelsDirty: false,
        bookmarksDirty: false,
        hasNativePdfMutationCapability: true,
        annotationSavePlan: {
            route: 'source-replay',
            reason: 'test-source-replay',
        },
        annotationDirty: false,
        hasAnnotationChanges: false,
        hasLivePdfJsAnnotationChanges: false,
        canPersistNativeMetadataMutations: true,
        totalPageCount: 2,
        pageLabelRanges: null,
        bookmarkItems: null,
        untitledBookmarkLabel: 'Untitled',
        shapes: null,
        deletedEmbeddedShapeAnnotationIds: [],
        deletedEmbeddedShapeStableKeys: [],
        markupSubtypeOverrides: undefined,
        markupSubtypeHints: [],
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

        const notes = buildNativeFreeTextNotesForSave(createMutationPlanInput({annotationCommentsSnapshot: [
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

        const updates = buildNativeNoteTextUpdatesForSave(createMutationPlanInput({
            pendingTexts,
            annotationCommentsSnapshot: [createComment()],
        }));

        expect(updates.value).toEqual([{
            objectNumber: 12,
            generationNumber: 0,
            text: 'Updated note',
        }]);
        expect(updates.skipEvents).toEqual([]);
    });

    it('builds native deletes for PDF refs and editor-only FreeText stable keys', () => {
        const deletes = buildNativeAnnotationDeletesForSave(createMutationPlanInput({pendingDeletes: [
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
            annotationCommentsSnapshot: [createComment({
                stableKey: 'ann:0:44R0',
                subtype: 'Highlight',
                color: '#ffee00',
                colorEdited: true,
                annotationId: '44R0',
                markerRect,
            })],
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
});

describe('buildNativePdfMutationPlanForSave', () => {
    it('assembles native notes, metadata, shapes, and markup into one mutation set', () => {
        const editorNote = createEditorFreeTextComment();
        const markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.1,
            height: 0.1,
        };

        const result = buildNativePdfMutationPlanForSave(createMutationPlanInput({
            annotationDirty: true,
            hasAnnotationChanges: true,
            annotationCommentsSnapshot: [
                editorNote,
                createComment({
                    stableKey: 'ann:0:44R0',
                    annotationId: '44R0',
                    subtype: 'Highlight',
                    color: '#ffee00',
                    markerRect,
                }),
            ],
            pendingTexts: new Map([[
                editorNote.stableKey,
                editorNote.text,
            ]]),
            pageLabelsDirty: true,
            pageLabelRanges: [{
                startPage: 1,
                style: 'D',
                prefix: 'A-',
                startNumber: 1,
            }],
            bookmarksDirty: true,
            bookmarkItems: [{
                title: 'Chapter',
                pageIndex: 0,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }],
            shapeStateDirty: true,
            shapes: [createShape()],
            markupSubtypeOverrides: new Map([[
                '44R0',
                'Underline',
            ]]),
        }));

        expect(result.plan?.phase).toBe('persist-native-pdf-mutations');
        expect(result.plan?.mutations.freeTextNotes).toEqual([expect.objectContaining({stableKey: editorNote.stableKey})]);
        expect(result.plan?.mutations.pageLabels?.ranges).toEqual([{
            startPage: 1,
            style: 'D',
            prefix: 'A-',
            startNumber: 1,
        }]);
        expect(result.plan?.mutations.bookmarks?.items).toEqual([expect.objectContaining({title: 'Chapter'})]);
        expect(result.plan?.mutations.shapes?.shapes).toEqual([expect.objectContaining({id: 'shape-1'})]);
        expect(result.plan?.mutations.markup?.overrides).toEqual([[
            '44R0',
            'Underline',
        ]]);
        expect(result.skipEvents).toEqual([expect.objectContaining({
            event: 'Skipped native note-text save fast path',
            reason: 'pending-text-not-native-eligible',
        })]);
    });

    it('returns null when pending texts are not covered by native mutations', () => {
        const result = buildNativePdfMutationPlanForSave(createMutationPlanInput({
            pendingTexts: new Map([[
                'missing-key',
                'Updated note',
            ]]),
            annotationCommentsSnapshot: [createComment()],
            annotationDirty: true,
            hasAnnotationChanges: true,
        }));

        expect(result.plan).toBeNull();
        expect(result.skipEvents).toContainEqual({
            event: 'Skipped native PDF mutation save fast path',
            reason: 'pending-texts-not-covered-by-native-mutations',
            details: {},
        });
    });

    it('uses native note updates when PDF.js materialization is requested but source replay covers the work', () => {
        const result = buildNativePdfMutationPlanForSave(createMutationPlanInput({
            forcePdfjsMaterialize: true,
            pendingTexts: new Map([[
                'ann:0:12R0',
                'Updated note',
            ]]),
            annotationCommentsSnapshot: [createComment()],
            annotationDirty: true,
            hasAnnotationChanges: true,
        }));

        expect(result.plan?.mutations.updates).toEqual([{
            objectNumber: 12,
            generationNumber: 0,
            text: 'Updated note',
        }]);
        expect(result.skipEvents).not.toContainEqual(expect.objectContaining({reason: 'pdfjs-materialize-required'}));
    });

    it('uses native FreeText note upserts and deletes when source replay covers materialized work', () => {
        const editorNote = createEditorFreeTextComment();
        const result = buildNativePdfMutationPlanForSave(createMutationPlanInput({
            forcePdfjsMaterialize: true,
            pendingDeletes: [createComment()],
            annotationCommentsSnapshot: [editorNote],
            annotationDirty: true,
            hasAnnotationChanges: true,
        }));

        expect(result.plan?.mutations.freeTextNotes).toEqual([expect.objectContaining({stableKey: editorNote.stableKey})]);
        expect(result.plan?.mutations.deletes).toEqual([{
            pageIndex: 0,
            objectNumber: 12,
            generationNumber: 0,
        }]);
        expect(result.skipEvents).not.toContainEqual(expect.objectContaining({reason: 'pdfjs-materialize-required'}));
    });

    it('keeps PDF.js materialization required when the flag is set without native-covered work', () => {
        const result = buildNativePdfMutationPlanForSave(createMutationPlanInput({
            forcePdfjsMaterialize: true,
            annotationDirty: true,
            hasAnnotationChanges: true,
        }));

        expect(result.plan).toBeNull();
        expect(result.skipEvents).toContainEqual({
            event: 'Skipped native PDF mutation save fast path',
            reason: 'pdfjs-materialize-required',
            details: {},
        });
    });
});
