import {
    describe,
    expect,
    it,
} from 'vitest';
import fc from 'fast-check';
import {
    classifyPdfSaveRoute,
    type IPdfSaveRouteCapabilities,
} from '@app/modules/pdf-viewer/runtime/save/classifyPdfSaveRoute';
import type { IPdfLiveAnnotationChangeSummary } from '@app/modules/pdf-viewer/runtime/save/pdfAnnotationStorageChanges';
import type {
    AnnotationEntity,
    IStickyNoteEntity,
    ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {IShapeAnnotation} from '@app/types/annotations';
import { asAnnotationId } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type { ISerializationPlanInputs } from '@app/modules/pdf-viewer/serialization/serializationPlan';
import { buildSerializationPlan } from '@app/modules/pdf-viewer/serialization/serializationPlan';
import { requireDocumentRevisionToken } from '@contracts';
import { requirePageIndex } from '@contracts/pageNumbers';
import type { IPdfNativeFreeTextEditor } from '@contracts/electronApiDocuments';

const MARKER_RECT = {
    left: 0.1,
    top: 0.2,
    width: 0.2,
    height: 0.1,
};

function embeddedNote(id: string, pdfRef: string): IStickyNoteEntity {
    return {
        kind: 'sticky-note',
        identity: {
            id: asAnnotationId(id),
            pdfRef,
        },
        pageIndex: 0,
        revision: 1,
        persistedRevision: 0,
        deleted: false,
        createdAt: 1_781_000_000_000,
        modifiedAt: null,
        author: 'Tester',
        text: `text-${id}`,
        anchor: MARKER_RECT,
        color: '#ffcc00',
    };
}

function cleanEmbeddedFreeTextNote(id: string, pdfRef: string): AnnotationEntity {
    return {
        ...embeddedNote(id, pdfRef),
        revision: 0,
        persistedRevision: 0,
    };
}

function editorNote(id: string): AnnotationEntity {
    return {
        kind: 'sticky-note',
        identity: {
            id: asAnnotationId(id),
            elementId: 'pdfjs_internal_editor_0',
        },
        pageIndex: 0,
        revision: 1,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1_781_000_000_000,
        modifiedAt: null,
        author: 'Tester',
        text: `text-${id}`,
        anchor: MARKER_RECT,
        color: '#ffcc00',
    };
}

function cleanEditorNote(id: string): AnnotationEntity {
    return {
        ...editorNote(id),
        revision: 0,
        persistedRevision: 0,
    };
}

function editorMarkup(id: string): ITextMarkupEntity {
    return {
        kind: 'text-markup',
        identity: {id: asAnnotationId(id)},
        pageIndex: 0,
        revision: 1,
        persistedRevision: -1,
        deleted: false,
        createdAt: null,
        modifiedAt: 1,
        author: null,
        subtype: 'Highlight',
        text: 'marked',
        geometry: [MARKER_RECT],
        color: '#ffff00',
        opacity: 1,
    };
}

function editorMarkupWithRuntimeIdentity(id: string): AnnotationEntity {
    return {
        ...editorMarkup(id),
        identity: {
            id: asAnnotationId(id),
            elementId: 'pdfjs_internal_editor_0',
        },
    };
}

function editorMarkupWithPdfAliases(
    id: string,
    runtimeId = 'pdfjs_internal_editor_2',
    pdfjsUid = 'pdfjs_markup_uid_2',
    pdfRef = '30R',
): AnnotationEntity {
    return {
        ...editorMarkup(id),
        identity: {
            id: asAnnotationId(id),
            elementId: runtimeId,
            pdfjsUid,
            pdfRef,
        },
    };
}

function deletedMarkup(
    id: string,
    pdfRef: string,
    elementId?: string,
): AnnotationEntity {
    return {
        ...editorMarkup(id),
        identity: {
            id: asAnnotationId(id),
            ...(elementId ? {elementId} : {}),
            pdfRef,
        },
        deleted: true,
    };
}

function embeddedMarkup(id: string, pdfRef: string): ITextMarkupEntity {
    return {
        ...editorMarkup(id),
        identity: {
            id: asAnnotationId(id),
            pdfRef,
        },
        persistedRevision: 0,
    };
}

function nativeShape(): IShapeAnnotation {
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
        createdAt: 1_781_000_000_000,
        modifiedAt: 1_781_000_000_100,
    };
}

function planOf(
    dirty: readonly AnnotationEntity[],
    entities: readonly AnnotationEntity[] = dirty,
    inputs: ISerializationPlanInputs = {},
) {
    return buildSerializationPlan({
        documentRevisionToken: requireDocumentRevisionToken('revision-1'),
        epoch: 1,
        entityBaselineHash: 'baseline',
        revisions: new Map(dirty.map(entity => [
            entity.identity.id,
            entity.revision,
        ])),
    }, dirty, entities, inputs);
}

function liveChanges(overrides: Partial<IPdfLiveAnnotationChangeSummary> = {}): IPdfLiveAnnotationChangeSummary {
    return {
        ids: new Set(),
        replayableEditorNoteIds: new Set(),
        nativeFreeTextEditors: new Map(),
        hasChanges: false,
        hasUnknownChanges: false,
        fingerprint: 'empty',
        ...overrides,
    };
}

function capabilities(overrides: Partial<IPdfSaveRouteCapabilities> = {}): IPdfSaveRouteCapabilities {
    return {
        saveFlowMode: 'save',
        rewriteShapeState: true,
        availableBackends: [
            'native-append',
            'pdfjs-save-document',
            'pdf-lib-rewrite',
        ],
        nativeCapabilities: {
            hasNativePdfMutationCapability: true,
            canPersistNativeMetadataMutations: true,
        },
        dirtyState: {
            annotationDirty: true,
            hasAnnotationChanges: true,
            hasLivePdfJsAnnotationChanges: false,
            savedPdfjsAnnotationBaselineDirty: false,
            shapeStateDirty: false,
        },
        documentStructure: {
            pageLabelsDirty: false,
            pageLabelRanges: [],
            bookmarksDirty: false,
            bookmarkItems: [],
            untitledBookmarkLabel: 'Untitled',
            totalPages: 4,
        },
        liveAnnotationChanges: liveChanges(),
        hasLoadedSource: true,
        forcePdfjsMaterialize: false,
        includeManagedShapesForLiveSource: false,
        totalPageCount: 4,
        shapes: null,
        deletedEmbeddedShapeAnnotationIds: [],
        deletedEmbeddedShapeStableKeys: [],
        markupSubtypeOverrides: undefined,
        markupSubtypeHints: [],
        ...overrides,
    };
}

describe('classifyPdfSaveRoute annotation routes', () => {
    it('replays pending embedded annotation operations from source bytes', () => {
        const decision = classifyPdfSaveRoute(planOf([], [editorNote('anno_editor_note')]), capabilities());

        expect(decision.annotationPlan).toMatchObject({
            route: 'source-replay',
            expectedCost: 'full-document',
            reason: 'pending-embedded-annotation-operations',
        });
    });

    it('replays from source when every live PDF.js id is covered by an embedded operation', () => {
        const decision = classifyPdfSaveRoute(
            planOf([deletedMarkup('anno_deleted', '9R')]),
            capabilities({liveAnnotationChanges: liveChanges({
                ids: new Set(['9R']),
                hasChanges: true,
                fingerprint: 'dirty',
            })}),
        );

        expect(decision.annotationPlan).toMatchObject({
            route: 'source-replay',
            reason: 'live-pdfjs-ids-covered-by-embedded-operations',
        });
    });

    it('materializes through PDF.js for unreplayable live annotation ids', () => {
        const decision = classifyPdfSaveRoute(
            planOf([embeddedNote('anno_note', '12R')]),
            capabilities({liveAnnotationChanges: liveChanges({
                ids: new Set(['pdfjs_internal_editor_7']),
                hasChanges: true,
                fingerprint: 'dirty',
            })}),
        );

        expect(decision.annotationPlan).toMatchObject({
            route: 'pdfjs-materialize',
            reason: 'unreplayable-live-pdfjs-annotation-ids',
            unreplayableLiveAnnotationIds: ['pdfjs_internal_editor_7'],
        });
    });

    it('materializes through PDF.js when live annotation storage inspection is unknown', () => {
        const decision = classifyPdfSaveRoute(
            planOf([]),
            capabilities({liveAnnotationChanges: liveChanges({
                hasChanges: true,
                hasUnknownChanges: true,
                fingerprint: 'unknown',
            })}),
        );

        expect(decision.annotationPlan).toMatchObject({
            route: 'pdfjs-materialize',
            reason: 'unknown-live-pdfjs-annotation-storage',
        });
    });

    it('materializes unknown live work even when pending replayable work covers every enumerated id', () => {
        const decision = classifyPdfSaveRoute(
            planOf([embeddedNote('anno_note', '12R')]),
            capabilities({liveAnnotationChanges: liveChanges({
                ids: new Set(),
                hasChanges: true,
                hasUnknownChanges: true,
                fingerprint: 'unknown-empty',
            })}),
        );

        expect(decision.annotationPlan).toMatchObject({
            route: 'pdfjs-materialize',
            reason: 'unknown-live-pdfjs-annotation-storage',
        });
    });

    it('materializes editor-only annotations that our serializer cannot replay', () => {
        const decision = classifyPdfSaveRoute(planOf([], [editorMarkup('anno_markup')]), capabilities());

        expect(decision.annotationPlan).toMatchObject({
            route: 'pdfjs-materialize',
            reason: 'editor-only-annotations-pending-materialization',
        });
    });

    it('keeps clean saves on the source-byte path', () => {
        const decision = classifyPdfSaveRoute(planOf([]), capabilities({dirtyState: {
            annotationDirty: false,
            hasAnnotationChanges: false,
            hasLivePdfJsAnnotationChanges: false,
            savedPdfjsAnnotationBaselineDirty: false,
            shapeStateDirty: false,
        }}));

        expect(decision.annotationPlan).toMatchObject({
            route: 'source-clean',
            expectedCost: 'small',
            reason: 'no-live-pdfjs-annotation-work',
        });
        expect(decision.route).toBe('source-clean');
        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('no-native-mutations-projected');
    });

    it('treats a declared dirty state PDF.js can no longer enumerate as unknown live work', () => {
        const decision = classifyPdfSaveRoute(planOf([]), capabilities({dirtyState: {
            annotationDirty: true,
            hasAnnotationChanges: true,
            hasLivePdfJsAnnotationChanges: true,
            savedPdfjsAnnotationBaselineDirty: false,
            shapeStateDirty: false,
        }}));

        expect(decision.annotationPlan).toMatchObject({
            route: 'pdfjs-materialize',
            reason: 'unknown-live-pdfjs-annotation-storage',
        });
    });
});

describe('classifyPdfSaveRoute native-append grant', () => {
    it('projects an imported markup note-only edit through the bounded native route', () => {
        const markup: AnnotationEntity = {
            ...embeddedMarkup('imported-markup-note', '44R'),
            revision: 1,
            text: 'Edited imported note',
        };
        const decision = classifyPdfSaveRoute(
            planOf([markup]),
            capabilities({
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: false,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'imported-markup-note',
                        '44R',
                    ]),
                    hasChanges: true,
                    fingerprint: 'imported-markup-note-only',
                }),
                markupSubtypeHints: [{
                    subtype: 'Highlight',
                    pageIndex: 0,
                    markerRect: MARKER_RECT,
                    consumed: false,
                    annotationId: '44R',
                    color: null,
                    pageMarkupIndex: 0,
                    source: 'pdf',
                }],
            }),
        );

        expect(decision.route).toBe('native-append');
        if (decision.route !== 'native-append') throw new Error('expected the native route');
        expect(decision.nativeMutationProjection.mutations.markup?.hints).toContainEqual(
            expect.objectContaining({
                annotationId: '44R',
                contents: 'Edited imported note',
            }),
        );
    });

    it('covers every live identity alias for a newly authored markup', () => {
        const markup = editorMarkupWithRuntimeIdentity('anno_new_markup');
        const decision = classifyPdfSaveRoute(
            planOf([markup]),
            capabilities({
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: false,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'anno_new_markup',
                        'pdfjs_internal_editor_0',
                    ]),
                    hasChanges: true,
                    fingerprint: 'new-markup',
                }),
            }),
        );

        expect(decision.route).toBe('native-append');
        if (decision.route !== 'native-append') throw new Error('expected the native route');
        expect(decision.nativeMutationProjection.hasMarkupMutations).toBe(true);
        expect(decision.nativeMutationProjection.mutations.markup?.hints).toEqual([expect.objectContaining({
            id: 'pdfjs_internal_editor_0',
            subtype: 'Highlight',
        })]);
    });

    it('rejects a markup payload when an unrelated live identity is present', () => {
        const markup = editorMarkupWithRuntimeIdentity('anno_new_markup');
        const decision = classifyPdfSaveRoute(
            planOf([markup]),
            capabilities({
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: false,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'anno_new_markup',
                        'pdfjs_internal_editor_0',
                        'unrelated-runtime-id',
                    ]),
                    hasChanges: true,
                    fingerprint: 'new-markup-plus-unrelated',
                }),
            }),
        );

        expect(decision.route).not.toBe('native-append');
        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('live-pdfjs-annotation-work-not-covered-by-native-mutations');
    });

    it.each([
        [
            'ordinary',
            'pdfjs_internal_editor_ordinary',
        ],
        [
            'Unicode',
            'pdfjs_internal_editor_unicode',
        ],
    ])('materializes newly authored markup beside an unsupported %s FreeText editor', (_label, freeTextId) => {
        const markup = editorMarkupWithRuntimeIdentity('anno_new_markup');
        const decision = classifyPdfSaveRoute(
            planOf([markup]),
            capabilities({
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: false,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'anno_new_markup',
                        'pdfjs_internal_editor_0',
                        freeTextId,
                    ]),
                    hasChanges: true,
                    fingerprint: `${_label}-freetext-plus-markup`,
                }),
            }),
        );

        expect(decision.annotationPlan.route).toBe('pdfjs-materialize');
        expect(decision.route).not.toBe('native-append');
        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('live-pdfjs-annotation-work-not-covered-by-native-mutations');
    });

    it('does not let a native FreeText editor map cover live work on the materialization route', () => {
        const markup = editorMarkupWithRuntimeIdentity('anno_new_markup');
        const editor: IPdfNativeFreeTextEditor = {
            pageIndex: requirePageIndex(0),
            stableKey: 'unsupported-editor-map-entry',
            text: 'ordinary editor text',
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
        const decision = classifyPdfSaveRoute(
            planOf([markup]),
            capabilities({
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: false,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'anno_new_markup',
                        'pdfjs_internal_editor_0',
                        'pdfjs_internal_editor_1',
                    ]),
                    nativeFreeTextEditors: new Map([[
                        'pdfjs_internal_editor_1',
                        editor,
                    ]]),
                    hasChanges: true,
                    fingerprint: 'materialize-with-native-freetext-map',
                }),
            }),
        );

        expect(decision.annotationPlan.route).toBe('pdfjs-materialize');
        expect(decision.route).not.toBe('native-append');
        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('live-pdfjs-annotation-work-not-covered-by-native-mutations');
    });

    it('rejects a valid markup alias paired with a stale raw hint alias', () => {
        const markup = editorMarkupWithRuntimeIdentity('anno_new_markup');
        const decision = classifyPdfSaveRoute(
            planOf([markup]),
            capabilities({
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: false,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'anno_new_markup',
                        'pdfjs_internal_editor_0',
                        'stale-markup-alias',
                    ]),
                    hasChanges: true,
                    fingerprint: 'valid-and-stale-markup-aliases',
                }),
                markupSubtypeHints: [{
                    subtype: 'Highlight',
                    pageIndex: 0,
                    markerRect: MARKER_RECT,
                    consumed: false,
                    id: 'pdfjs_internal_editor_0',
                    annotationId: 'stale-markup-alias',
                    color: '#ffff00',
                    pageMarkupIndex: 0,
                    source: 'editor-live',
                }],
            }),
        );

        expect(decision.route).not.toBe('native-append');
        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('live-pdfjs-annotation-work-not-covered-by-native-mutations');
    });

    it('rejects a valid markup override when another live alias is not covered', () => {
        const markup = editorMarkupWithRuntimeIdentity('anno_new_markup');
        const decision = classifyPdfSaveRoute(
            planOf([markup]),
            capabilities({
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: false,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'anno_new_markup',
                        'pdfjs_internal_editor_0',
                        'stale-markup-alias',
                    ]),
                    hasChanges: true,
                    fingerprint: 'valid-override-plus-stale-alias',
                }),
                markupSubtypeOverrides: new Map([[
                    'pdfjs_internal_editor_0',
                    'Underline',
                ]]),
            }),
        );

        expect(decision.route).not.toBe('native-append');
        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('live-pdfjs-annotation-work-not-covered-by-native-mutations');
    });

    it('covers all app, runtime, and PDF.js aliases for newly authored markup', () => {
        const markup = editorMarkupWithPdfAliases('anno_new_markup');
        const decision = classifyPdfSaveRoute(
            planOf([markup]),
            capabilities({
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: false,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'anno_new_markup',
                        'pdfjs_internal_editor_2',
                        'pdfjs_markup_uid_2',
                        '30R',
                    ]),
                    hasChanges: true,
                    fingerprint: 'all-new-markup-aliases',
                }),
                markupSubtypeHints: [{
                    subtype: 'Highlight',
                    pageIndex: 0,
                    markerRect: MARKER_RECT,
                    consumed: false,
                    id: 'pdfjs_internal_editor_2',
                    annotationId: '30R',
                    color: '#ffff00',
                    pageMarkupIndex: 0,
                    source: 'editor-live',
                }],
            }),
        );

        expect(decision.route).toBe('native-append');
        if (decision.route !== 'native-append') throw new Error('expected the native route');
        expect(decision.nativeMutationProjection.hasMarkupMutations).toBe(true);
    });

    it('drops a retired PDF ref when rematerializing an undone saved markup', () => {
        const markup: AnnotationEntity = {
            ...editorMarkupWithRuntimeIdentity('anno_saved_highlight_undo'),
            revision: 0,
            persistedRevision: -1,
            identity: {
                id: asAnnotationId('anno_saved_highlight_undo'),
                elementId: '9R',
                // A late PDF.js/editor snapshot can put the ref retired by
                // the preceding delete back on the canonical entity. A
                // transient replay must create a new object instead of
                // targeting that now-null ref.
                pdfRef: '9R0',
                pdfName: 'evb-markup:pdfjs_internal_editor_0',
                pdfjsUid: 'pdfjs_saved_highlight_undo',
            },
        };
        const decision = classifyPdfSaveRoute(
            planOf([markup]),
            capabilities({
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: false,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'anno_saved_highlight_undo',
                        '9R',
                        'pdfjs_saved_highlight_undo',
                    ]),
                    hasChanges: true,
                    fingerprint: 'saved-highlight-undo',
                }),
                markupSubtypeHints: [{
                    subtype: 'Highlight',
                    pageIndex: 0,
                    markerRect: MARKER_RECT,
                    consumed: false,
                    id: 'pdfjs_saved_highlight_undo',
                    annotationId: '9R0',
                    color: '#ffff00',
                    pageMarkupIndex: 0,
                    source: 'editor-live',
                }],
            }),
        );

        expect(decision.route).toBe('native-append');
        if (decision.route !== 'native-append') throw new Error('expected the native route');
        expect(decision.canonical.comments[0]).toMatchObject({
            annotationName: 'evb-markup:pdfjs_internal_editor_0',
            source: 'editor',
            annotationId: null,
        });
        const hints = decision.nativeMutationProjection.mutations.markup?.hints ?? [];
        expect(hints).not.toContainEqual(expect.objectContaining({annotationId: '9R0'}));
        expect(hints).toContainEqual(expect.objectContaining({
            appAnnotationId: 'anno_saved_highlight_undo',
            id: '9R',
            annotationId: null,
            source: 'editor',
        }));
    });

    it('keeps narrow sticky replayability beside native FreeText and new markup', () => {
        const savedInlineNote = {
            ...cleanEditorNote('anno_saved_inline_note'),
            identity: {
                id: asAnnotationId('anno_saved_inline_note'),
                elementId: 'pdfjs_internal_editor_0',
            },
        };
        const markup = editorMarkupWithPdfAliases(
            'anno_new_markup',
            'pdfjs_internal_editor_2',
            'pdfjs_markup_uid_2',
            '30R',
        );
        const newEditor: IPdfNativeFreeTextEditor = {
            pageIndex: requirePageIndex(0),
            stableKey: 'new-editor',
            text: 'new text',
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
        const decision = classifyPdfSaveRoute(
            planOf([markup], [
                savedInlineNote,
                markup,
            ]),
            capabilities({
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: false,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'pdfjs_internal_editor_0',
                        'pdfjs_internal_editor_1',
                        'anno_new_markup',
                        'pdfjs_internal_editor_2',
                        'pdfjs_markup_uid_2',
                        '30R',
                    ]),
                    replayableEditorNoteIds: new Set(['pdfjs_internal_editor_0']),
                    nativeFreeTextEditors: new Map([[
                        'pdfjs_internal_editor_1',
                        newEditor,
                    ]]),
                    hasChanges: true,
                    fingerprint: 'saved-inline-native-freetext-new-markup',
                }),
                markupSubtypeHints: [{
                    subtype: 'Highlight',
                    pageIndex: 0,
                    markerRect: MARKER_RECT,
                    consumed: false,
                    id: 'pdfjs_internal_editor_2',
                    annotationId: '30R',
                    color: '#ffff00',
                    pageMarkupIndex: 0,
                    source: 'editor-live',
                }],
            }),
        );

        expect(decision.annotationPlan.route).toBe('pdfjs-materialize');
        expect(decision.annotationPlan.unreplayableLiveAnnotationIds)
            .not.toContain('pdfjs_internal_editor_0');
        expect(decision.route).not.toBe('native-append');
        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('live-pdfjs-annotation-work-not-covered-by-native-mutations');
    });

    it('classifies one combined notes, metadata, shapes, and markup payload', () => {
        const deleted = deletedMarkup('anno_deleted', '20R');
        const decision = classifyPdfSaveRoute(
            planOf(
                [deleted],
                [
                    editorNote('anno_editor_note'),
                    embeddedMarkup('anno_markup', '44R'),
                    deleted,
                ],
            ),
            capabilities({
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: false,
                    savedPdfjsAnnotationBaselineDirty: false,
                    shapeStateDirty: true,
                },
                documentStructure: {
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
                    untitledBookmarkLabel: 'Untitled',
                    totalPages: 4,
                },
                shapes: [nativeShape()],
                markupSubtypeOverrides: new Map([[
                    '44R',
                    'Underline',
                ]]),
            }),
        );

        expect(decision.route).toBe('native-append');
        if (decision.route !== 'native-append') throw new Error('expected the native route');
        expect(decision.nativeMutationProjection.mutations).toMatchObject({
            freeTextNotes: [expect.objectContaining({stableKey: 'src:editor:0:pdfjs_internal_editor_0'})],
            deletes: [expect.objectContaining({
                objectNumber: 20,
                generationNumber: 0,
            })],
            pageLabels: {ranges: [expect.objectContaining({prefix: 'A-'})]},
            bookmarks: {items: [expect.objectContaining({title: 'Chapter'})]},
            shapes: {shapes: [expect.objectContaining({
                annotationId: '22R',
                stableKey: 'ann:0:22R0',
            })]},
            markup: {overrides: [[
                '44R',
                'Underline',
            ]]},
        });
        expect(decision.nativeMutationProjection.mutations.shapes?.shapes[0])
            .not.toHaveProperty('id');
    });

    it('projects a PDF-backed FreeText edit to a native text update', () => {
        const decision = classifyPdfSaveRoute(
            planOf([embeddedNote('anno_note', '12R')]),
            capabilities(),
        );

        expect(decision.route).toBe('native-append');
        if (decision.route !== 'native-append') throw new Error('expected the native route');
        expect(decision.nativeMutationProjection.mutations).toMatchObject({updates: [expect.objectContaining({
            objectNumber: 12,
            generationNumber: 0,
            text: 'text-anno_note',
        })]});
    });

    it('projects an imported sticky-note move to a native geometry update', () => {
        const moved: IStickyNoteEntity = {
            ...embeddedNote('anno_moved_text', '12R'),
            identity: {
                id: asAnnotationId('anno_moved_text'),
                pdfName: 'evb-pdf-004-text-parent',
                pdfRef: '12R',
            },
            pageIndex: 1,
            anchor: {
                left: 0.6,
                top: 0.25,
                width: 0.15,
                height: 0.12,
            },
        };
        const decision = classifyPdfSaveRoute(
            planOf([moved]),
            capabilities({
                totalPageCount: 2,
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: true,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'anno_moved_text',
                        '12R',
                    ]),
                    replayableEditorNoteIds: new Set(['12R']),
                    hasChanges: true,
                    fingerprint: 'moved-imported-sticky-note',
                }),
            }),
        );

        expect(decision.route).toBe('native-append');
        if (decision.route !== 'native-append') throw new Error('expected the native route');
        expect(decision.nativeMutationProjection.mutations).toMatchObject({geometryUpdates: [{
            objectNumber: 12,
            generationNumber: 0,
            pageIndex: 1,
            markerRect: moved.anchor,
        }]});

        const unrelatedLiveChange = classifyPdfSaveRoute(
            planOf([moved]),
            capabilities({
                totalPageCount: 2,
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: true,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'anno_moved_text',
                        '12R',
                        'unrelated-runtime-id',
                    ]),
                    replayableEditorNoteIds: new Set(['12R']),
                    hasChanges: true,
                    fingerprint: 'moved-imported-sticky-note-plus-unrelated-change',
                }),
            }),
        );
        expect(unrelatedLiveChange.route).toBe('pdfjs-materialize');
        if (unrelatedLiveChange.route === 'native-append') throw new Error('expected a byte route');
        expect(unrelatedLiveChange.annotationPlan.unreplayableLiveAnnotationIds)
            .toEqual(['unrelated-runtime-id']);
    });

    it('projects imported FreeText geometry and style edits through the native editor route', () => {
        const importedEditor: IPdfNativeFreeTextEditor = {
            pageIndex: requirePageIndex(0),
            stableKey: 'pdf-ref-44R',
            annotationId: '44R',
            text: 'edited imported text',
            rect: [
                20,
                30,
                180,
                80,
            ],
            rotation: 0,
            fontSize: 18,
            color: [
                17,
                24,
                39,
            ],
        };
        const clean = cleanEmbeddedFreeTextNote('imported-freetext', '44R');
        const decision = classifyPdfSaveRoute(
            planOf([], [clean]),
            capabilities({
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: false,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set(['44R']),
                    nativeFreeTextEditors: new Map([[
                        '44R',
                        importedEditor,
                    ]]),
                    hasChanges: true,
                    fingerprint: 'imported-freetext-style-edit',
                }),
            }),
        );

        expect(decision.route).toBe('native-append');
        if (decision.route !== 'native-append') throw new Error('expected the native route');
        expect(decision.nativeMutationProjection.mutations.freeTextEditors).toEqual([importedEditor]);
    });

    it('covers every PDF.js identity alias when a saved sticky note has a native text update', () => {
        const note: AnnotationEntity = {
            ...embeddedNote('anno_saved_note', '12R'),
            identity: {
                id: asAnnotationId('anno_saved_note'),
                elementId: 'pdfjs_internal_editor_0',
                pdfjsUid: 'pdfjs_internal_editor_0',
                pdfRef: '12R',
            },
        };
        const decision = classifyPdfSaveRoute(
            planOf([note]),
            capabilities({
                forcePdfjsMaterialize: true,
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: true,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'anno_saved_note',
                        'pdfjs_internal_editor_0',
                        '12R',
                    ]),
                    replayableEditorNoteIds: new Set(),
                    hasChanges: true,
                    fingerprint: 'saved-sticky-note-aliases',
                }),
            }),
        );

        expect(decision.route).toBe('native-append');
        if (decision.route !== 'native-append') throw new Error('expected the native route');
        expect(decision.nativeMutationProjection.noteTextUpdates).toEqual([expect.objectContaining({
            objectNumber: 12,
            generationNumber: 0,
            text: 'text-anno_saved_note',
        })]);
    });

    it('normalizes nested editor aliases captured from the canonical frontier', () => {
        const note: AnnotationEntity = {
            ...editorNote('anno_nested_editor'),
            identity: {
                id: asAnnotationId('anno_nested_editor'),
                elementId: 'editor:0:pdfjs_internal_editor_0',
            },
        };

        const decision = classifyPdfSaveRoute(planOf([note]), capabilities());

        expect(decision.canonical.liveAnnotationChanges.ids).toContain('editor:0:pdfjs_internal_editor_0');
        expect(decision.canonical.liveAnnotationChanges.ids).toContain('pdfjs_internal_editor_0');
        expect(decision.canonical.liveAnnotationChanges.replayableEditorNoteIds)
            .toContain('pdfjs_internal_editor_0');
    });

    it('does not let a sticky-note text update cover an unrelated live PDF.js identity', () => {
        const decision = classifyPdfSaveRoute(
            planOf([embeddedNote('anno_saved_note', '12R')]),
            capabilities({
                forcePdfjsMaterialize: true,
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: true,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        '12R',
                        'unrelated-runtime-id',
                    ]),
                    replayableEditorNoteIds: new Set(['12R']),
                    hasChanges: true,
                    fingerprint: 'sticky-note-plus-unrelated-change',
                }),
            }),
        );

        expect(decision.route).toBe('pdfjs-materialize');
        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('saved-pdfjs-baseline-dirty-requires-materialization');
    });

    it('materializes a non-replayable live id that only aliases a clean persisted sticky note', () => {
        const savedEntity = {
            ...cleanEmbeddedFreeTextNote('anno_saved', '50R'),
            identity: {
                id: asAnnotationId('anno_saved'),
                elementId: 'pdfjs_internal_editor_0',
                pdfRef: '50R',
            },
        };
        const newEntity = embeddedNote('anno_new', '60R');
        const newEditor: IPdfNativeFreeTextEditor = {
            pageIndex: requirePageIndex(0),
            stableKey: 'new-ordinary-editor',
            text: 'ordinary editor text',
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
        const decision = classifyPdfSaveRoute(
            planOf([newEntity], [
                savedEntity,
                newEntity,
            ]),
            capabilities({
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: true,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'pdfjs_internal_editor_0',
                        'pdfjs_internal_editor_1',
                        '60R',
                    ]),
                    nativeFreeTextEditors: new Map([[
                        'pdfjs_internal_editor_1',
                        newEditor,
                    ]]),
                    hasChanges: true,
                    fingerprint: 'non-replayable-clean-alias',
                }),
            }),
        );

        expect(decision.annotationPlan).toMatchObject({
            route: 'pdfjs-materialize',
            reason: 'unreplayable-live-pdfjs-annotation-ids',
            unreplayableLiveAnnotationIds: expect.arrayContaining(['pdfjs_internal_editor_0']),
        });
        expect(decision.route).not.toBe('native-append');
        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('saved-pdfjs-baseline-dirty-requires-materialization');
    });

    it('keeps a clean embedded FreeText out of native pending texts beside a new editor', () => {
        const editor: IPdfNativeFreeTextEditor = {
            pageIndex: requirePageIndex(0),
            stableKey: 'freetext-new-editor',
            text: 'New editor text',
            rect: [
                20,
                30,
                180,
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
        const decision = classifyPdfSaveRoute(
            planOf([cleanEmbeddedFreeTextNote('anno_clean_note', '12R')]),
            capabilities({liveAnnotationChanges: liveChanges({
                ids: new Set(['pdfjs_internal_editor_0']),
                hasChanges: true,
                fingerprint: 'new-editor',
                nativeFreeTextEditors: new Map([[
                    'pdfjs_internal_editor_0',
                    editor,
                ]]),
            })}),
        );

        expect(decision.route).toBe('native-append');
        expect(decision.canonical.pendingTexts).toEqual(new Map());
        if (decision.route !== 'native-append') throw new Error('expected the native route');
        expect(decision.dirtyState.annotationDirty).toBe(true);
        expect(decision.nativeMutationProjection).toMatchObject({
            freeTextNotes: [],
            freeTextEditors: [editor],
        });
    });

    it('replays saved and new FreeText editors idempotently through the native route', () => {
        const savedEditor: IPdfNativeFreeTextEditor = {
            pageIndex: requirePageIndex(0),
            stableKey: 'saved-editor',
            text: 'already saved',
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
        const newEditor: IPdfNativeFreeTextEditor = {
            ...savedEditor,
            stableKey: 'new-editor',
            text: 'new text',
        };
        const decision = classifyPdfSaveRoute(
            planOf([editorNote('anno_app')]),
            capabilities({
                forcePdfjsMaterialize: true,
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: true,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'anno_app',
                        'pdfjs_internal_editor_0',
                        'new-runtime-id',
                    ]),
                    nativeFreeTextEditors: new Map([
                        [
                            'pdfjs_internal_editor_0',
                            savedEditor,
                        ],
                        [
                            'new-runtime-id',
                            newEditor,
                        ],
                    ]),
                    hasChanges: true,
                    fingerprint: 'saved-plus-new',
                }),
            }),
        );

        expect(decision.route).toBe('native-append');
        if (decision.route !== 'native-append') throw new Error('expected the native route');
        expect(decision.nativeMutationProjection.freeTextEditors).toEqual([
            savedEditor,
            newEditor,
        ]);
    });

    it('keeps a saved Inline Note anchor on the native route beside a new FreeText editor', () => {
        const newEditor: IPdfNativeFreeTextEditor = {
            pageIndex: requirePageIndex(0),
            stableKey: 'new-editor',
            text: 'new text',
            rect: [
                10,
                20,
                110,
                60,
            ],
            rotation: 0,
            fontSize: 16,
            color: [
                17,
                24,
                39,
            ],
        };
        const decision = classifyPdfSaveRoute(
            planOf([], [cleanEditorNote('anno_saved_inline_note')]),
            capabilities({
                forcePdfjsMaterialize: true,
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: true,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'pdfjs_internal_editor_0',
                        'pdfjs_internal_editor_1',
                    ]),
                    replayableEditorNoteIds: new Set(['pdfjs_internal_editor_0']),
                    nativeFreeTextEditors: new Map([[
                        'pdfjs_internal_editor_1',
                        newEditor,
                    ]]),
                    hasChanges: true,
                    fingerprint: 'saved-inline-note-plus-new-editor',
                }),
            }),
        );

        expect(decision.route).toBe('native-append');
        if (decision.route !== 'native-append') throw new Error('expected the native route');
        expect(decision.nativeMutationProjection.freeTextEditors).toEqual([newEditor]);
        expect(decision.nativeMutationProjection.freeTextNotes).toEqual([]);
    });

    it('keeps a changed Inline Note and a new FreeText editor on the native route', () => {
        const savedEntity = {
            ...editorNote('anno_saved'),
            revision: 1,
            persistedRevision: 1,
        };
        const newEntity = {
            ...editorNote('anno_new'),
            identity: {
                id: asAnnotationId('anno_new'),
                elementId: 'new-runtime-id',
            },
        };
        const newEditor: IPdfNativeFreeTextEditor = {
            pageIndex: requirePageIndex(0),
            stableKey: 'src:editor:0:new-runtime-id',
            text: 'new text',
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
        const decision = classifyPdfSaveRoute(
            planOf([newEntity], [
                savedEntity,
                newEntity,
            ]),
            capabilities({
                forcePdfjsMaterialize: true,
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: true,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'pdfjs_internal_editor_0',
                        'new-runtime-id',
                    ]),
                    replayableEditorNoteIds: new Set(['pdfjs_internal_editor_0']),
                    nativeFreeTextEditors: new Map([[
                        'new-runtime-id',
                        newEditor,
                    ]]),
                    hasChanges: true,
                    fingerprint: 'acknowledged-plus-new',
                }),
            }),
        );

        expect(decision.route).toBe('native-append');
        if (decision.route !== 'native-append') throw new Error('expected the native route');
        expect(decision.nativeMutationProjection.freeTextEditors).toEqual([newEditor]);
    });

    it('does not let a replayable alias without a projected mutation ride an unrelated editor save', () => {
        const editor: IPdfNativeFreeTextEditor = {
            pageIndex: requirePageIndex(0),
            stableKey: 'new-editor',
            text: 'new text',
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
        const decision = classifyPdfSaveRoute(
            planOf([editorNote('anno_app')]),
            capabilities({
                forcePdfjsMaterialize: true,
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: true,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'anno_app',
                        'pdfjs_internal_editor_0',
                        '12R',
                    ]),
                    replayableEditorNoteIds: new Set(['12R']),
                    nativeFreeTextEditors: new Map([[
                        'pdfjs_internal_editor_0',
                        editor,
                    ]]),
                    hasChanges: true,
                    fingerprint: 'unprojected-alias-plus-editor',
                }),
            }),
        );

        expect(decision.route).not.toBe('native-append');
        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('saved-pdfjs-baseline-dirty-requires-materialization');
    });

    it('keeps an unknown saved PDF.js baseline change on the materializing route', () => {
        const decision = classifyPdfSaveRoute(
            planOf([]),
            capabilities({
                forcePdfjsMaterialize: true,
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: true,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set(['unknown-runtime-id']),
                    hasChanges: true,
                    hasUnknownChanges: true,
                    fingerprint: 'unknown',
                }),
            }),
        );

        expect(decision.route).not.toBe('native-append');
        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('saved-pdfjs-baseline-dirty-requires-materialization');
    });

    it('does not treat a clean embedded FreeText as live annotation work', () => {
        const decision = classifyPdfSaveRoute(
            planOf([cleanEmbeddedFreeTextNote('anno_clean_note', '12R')]),
            capabilities(),
        );

        expect(decision.annotationPlan).toMatchObject({
            route: 'source-clean',
            reason: 'no-live-pdfjs-annotation-work',
        });
        expect(decision.canonical.pendingTexts).toEqual(new Map());
        expect(decision.canonical.liveAnnotationChanges.hasChanges).toBe(false);
    });

    it('grants the native route with the unforced annotation route even under forced materialization', () => {
        const decision = classifyPdfSaveRoute(
            planOf([deletedMarkup('anno_deleted', '12R')]),
            capabilities({forcePdfjsMaterialize: true}),
        );

        expect(decision.route).toBe('native-append');
        expect(decision.annotationPlan).toMatchObject({
            route: 'pdfjs-materialize',
            reason: 'live-pdfjs-annotation-baseline-diverged',
        });
        if (decision.route !== 'native-append') throw new Error('expected the native route');
        expect(decision.annotationRoute.route).toBe('source-replay');
        expect(decision.replayableAnnotationMutationsAllowed).toBe(true);
        expect(decision.pdfjsMaterializeForced).toBe(true);
        expect(decision.fallback.route).toBe('pdfjs-materialize');
    });

    it('covers a dirty saved PDF.js baseline with the exact canonical native delete', () => {
        const decision = classifyPdfSaveRoute(
            planOf([deletedMarkup('anno_deleted', '12R', 'pdfjs_internal_editor_0')]),
            capabilities({
                forcePdfjsMaterialize: true,
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: true,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'anno_deleted',
                        'pdfjs_internal_editor_0',
                        '12R',
                    ]),
                    hasChanges: true,
                    fingerprint: 'exact-native-delete-aliases',
                }),
            }),
        );

        expect(decision.route).toBe('native-append');
        if (decision.route !== 'native-append') throw new Error('expected the native route');
        expect(decision.nativeMutationProjection.annotationDeletes).toEqual([{
            pageIndex: 0,
            objectNumber: 12,
            generationNumber: 0,
        }]);
    });

    it('keeps an unrelated live runtime ID on the materializing route beside an exact native delete', () => {
        const decision = classifyPdfSaveRoute(
            planOf([deletedMarkup('anno_deleted', '12R', 'pdfjs_internal_editor_0')]),
            capabilities({
                forcePdfjsMaterialize: true,
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: true,
                    shapeStateDirty: false,
                },
                liveAnnotationChanges: liveChanges({
                    ids: new Set([
                        'anno_deleted',
                        'pdfjs_internal_editor_0',
                        '12R',
                        'unrelated-runtime-id',
                    ]),
                    hasChanges: true,
                    fingerprint: 'native-delete-plus-unrelated-runtime-id',
                }),
            }),
        );

        expect(decision.route).not.toBe('native-append');
        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('saved-pdfjs-baseline-dirty-requires-materialization');
    });

    it('rejects a native delete when the tombstone has no exact native target', () => {
        const unresolvedDelete: AnnotationEntity = {
            ...editorMarkup('anno_unresolved'),
            deleted: true,
        };
        const decision = classifyPdfSaveRoute(
            planOf([unresolvedDelete]),
            capabilities(),
        );

        expect(decision.route).not.toBe('native-append');
        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('pending-deletes-not-covered-by-native-mutations');
    });

    it('rejects duplicate tombstones that collapse onto one native delete target', () => {
        const decision = classifyPdfSaveRoute(
            planOf([
                deletedMarkup('anno_deleted_a', '12R'),
                deletedMarkup('anno_deleted_b', '12R'),
            ]),
            capabilities(),
        );

        expect(decision.route).not.toBe('native-append');
        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('pending-deletes-not-covered-by-native-mutations');
    });

    it('refuses the native route when the plan forces a rewrite backend', () => {
        const decision = classifyPdfSaveRoute(
            planOf([embeddedNote('anno_note', '12R')], [embeddedNote('anno_note', '12R')], {routeConstraints: {
                forceRewrite: true,
                allowedBackends: ['pdf-lib-rewrite'],
            }}),
            capabilities(),
        );

        expect(decision.route).toBe('source-replay');
        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('backend-not-native-append');
    });

    it.each([
        [
            'not-save-mode',
            {saveFlowMode: 'save_as'},
        ],
        [
            'native-save-capability-unavailable',
            {nativeCapabilities: {
                hasNativePdfMutationCapability: false,
                canPersistNativeMetadataMutations: true,
            }},
        ],
        [
            'managed-shapes-require-materialization',
            {includeManagedShapesForLiveSource: true},
        ],
        [
            'save-descriptors-unavailable',
            {dirtyState: undefined},
        ],
    ] as const)('refuses the native route with %s', (rejection, overrides) => {
        const decision = classifyPdfSaveRoute(
            planOf([embeddedNote('anno_note', '12R')]),
            capabilities(overrides),
        );

        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe(rejection);
    });

    it('rejects structured native work when the metadata capability is unavailable', () => {
        const decision = classifyPdfSaveRoute(planOf([]), capabilities({
            nativeCapabilities: {
                hasNativePdfMutationCapability: true,
                canPersistNativeMetadataMutations: false,
            },
            dirtyState: {
                annotationDirty: false,
                hasAnnotationChanges: false,
                hasLivePdfJsAnnotationChanges: false,
                savedPdfjsAnnotationBaselineDirty: false,
                shapeStateDirty: false,
            },
            documentStructure: {
                pageLabelsDirty: true,
                pageLabelRanges: [{
                    startPage: 1,
                    style: 'D',
                    prefix: '',
                    startNumber: 1,
                }],
                bookmarksDirty: false,
                bookmarkItems: [],
                untitledBookmarkLabel: 'Untitled',
                totalPages: 4,
            },
        }));

        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('native-structured-save-capability-unavailable');
    });
});

// Distinct identities: a serialization plan never carries the same annotation twice.
const ENTITY_POOL: readonly AnnotationEntity[] = [
    embeddedNote('anno_embedded_0', '10R'),
    embeddedNote('anno_embedded_1', '11R'),
    editorNote('anno_editor_note_0'),
    editorMarkup('anno_editor_markup_0'),
    deletedMarkup('anno_deleted_0', '20R'),
];

const CAPABILITIES_ARBITRARY = fc.record({
    saveFlowMode: fc.constantFrom('save' as const, 'save_as' as const),
    withNativeCapabilities: fc.boolean(),
    withDirtyState: fc.boolean(),
    withDocumentStructure: fc.boolean(),
    hasNativePdfMutationCapability: fc.boolean(),
    canPersistNativeMetadataMutations: fc.boolean(),
    annotationDirty: fc.boolean(),
    hasAnnotationChanges: fc.boolean(),
    hasLivePdfJsAnnotationChanges: fc.boolean(),
    savedPdfjsAnnotationBaselineDirty: fc.boolean(),
    shapeStateDirty: fc.boolean(),
    pageLabelsDirty: fc.boolean(),
    bookmarksDirty: fc.boolean(),
    hasLoadedSource: fc.boolean(),
    forcePdfjsMaterialize: fc.boolean(),
    includeManagedShapesForLiveSource: fc.boolean(),
    forceRewrite: fc.boolean(),
    liveIds: fc.array(fc.constantFrom('10R', '11R', 'pdfjs_internal_editor_0', '20R'), {maxLength: 3}),
    liveHasChanges: fc.boolean(),
    liveHasUnknownChanges: fc.boolean(),
});

type TGeneratedCapabilities = ReturnType<typeof CAPABILITIES_ARBITRARY.generate>['value'];

function generatedCapabilities(generated: TGeneratedCapabilities): IPdfSaveRouteCapabilities {
    return capabilities({
        saveFlowMode: generated.saveFlowMode,
        nativeCapabilities: generated.withNativeCapabilities
            ? {
                hasNativePdfMutationCapability: generated.hasNativePdfMutationCapability,
                canPersistNativeMetadataMutations: generated.canPersistNativeMetadataMutations,
            }
            : undefined,
        dirtyState: generated.withDirtyState
            ? {
                annotationDirty: generated.annotationDirty,
                hasAnnotationChanges: generated.hasAnnotationChanges,
                hasLivePdfJsAnnotationChanges: generated.hasLivePdfJsAnnotationChanges,
                savedPdfjsAnnotationBaselineDirty: generated.savedPdfjsAnnotationBaselineDirty,
                shapeStateDirty: generated.shapeStateDirty,
            }
            : undefined,
        documentStructure: generated.withDocumentStructure
            ? {
                pageLabelsDirty: generated.pageLabelsDirty,
                pageLabelRanges: [],
                bookmarksDirty: generated.bookmarksDirty,
                bookmarkItems: [],
                untitledBookmarkLabel: 'Untitled',
                totalPages: 4,
            }
            : undefined,
        hasLoadedSource: generated.hasLoadedSource,
        forcePdfjsMaterialize: generated.forcePdfjsMaterialize,
        includeManagedShapesForLiveSource: generated.includeManagedShapesForLiveSource,
        liveAnnotationChanges: liveChanges({
            ids: new Set(generated.liveIds),
            hasChanges: generated.liveHasChanges
                || generated.liveHasUnknownChanges
                || generated.liveIds.length > 0,
            hasUnknownChanges: generated.liveHasUnknownChanges,
            fingerprint: generated.liveIds.join(','),
        }),
    });
}

const ROUTE_DECISION_ARBITRARY = fc
    .tuple(fc.subarray([...ENTITY_POOL]), CAPABILITIES_ARBITRARY)
    .map(([
        entities,
        generated,
    ]) => {
        const resolved = generatedCapabilities(generated);
        const plan = planOf(entities, entities, {routeConstraints: {
            forceRewrite: generated.forceRewrite,
            allowedBackends: generated.forceRewrite
                ? ['pdf-lib-rewrite']
                : [
                    'native-append',
                    'pdfjs-save-document',
                    'pdf-lib-rewrite',
                ],
        }});
        return {
            plan,
            resolved,
            decision: classifyPdfSaveRoute(plan, resolved),
        };
    });

describe('classifyPdfSaveRoute route properties', () => {
    it('emits exactly one route for every generated combination', () => {
        fc.assert(fc.property(ROUTE_DECISION_ARBITRARY, ({decision}) => {
            expect([
                'native-append',
                'source-clean',
                'source-replay',
                'pdfjs-materialize',
            ]).toContain(decision.route);
            if (decision.route === 'native-append') {
                expect(decision.fallback.route).toBe(decision.annotationPlan.route);
                expect(decision.fallback.route).not.toBe('native-append');
                return;
            }
            expect(decision.route).toBe(decision.annotationPlan.route);
        }), {numRuns: 400});
    });

    it('is deterministic in the frozen plan and its capability descriptors', () => {
        fc.assert(fc.property(ROUTE_DECISION_ARBITRARY, ({
            plan,
            resolved,
            decision,
        }) => {
            expect(classifyPdfSaveRoute(plan, resolved).route).toBe(decision.route);
            expect(classifyPdfSaveRoute(plan, resolved).annotationPlan).toEqual(decision.annotationPlan);
        }), {numRuns: 200});
    });

    it('reaches each fallback route only through its documented precondition', () => {
        fc.assert(fc.property(ROUTE_DECISION_ARBITRARY, ({
            resolved,
            decision,
        }) => {
            const byteRoute = decision.route === 'native-append' ? decision.fallback : decision;

            // Source-byte reads require a loaded source and a non-materializing route.
            expect(byteRoute.baseBytes === 'loaded-source').toBe(
                resolved.hasLoadedSource && byteRoute.route !== 'pdfjs-materialize',
            );
            // Falling back to source bytes after a failed materialization is a
            // source-replay-only affordance.
            expect(byteRoute.sourceFallbackAllowed).toBe(byteRoute.route === 'source-replay');
            // Forced PDF.js materialization always wins the byte route.
            if (resolved.forcePdfjsMaterialize) {
                expect(byteRoute.route).toBe('pdfjs-materialize');
            }
            // A clean route means no live annotation work was observed at all.
            if (byteRoute.route === 'source-clean') {
                expect(decision.canonical.liveAnnotationChanges.hasChanges).toBe(false);
                expect(decision.canonical.pendingTexts.size).toBe(0);
                expect(decision.canonical.pendingDeletes.length).toBe(0);
            }
        }), {numRuns: 400});
    });

    it('grants the native route only when every documented capability precondition holds', () => {
        fc.assert(fc.property(ROUTE_DECISION_ARBITRARY, ({
            plan,
            resolved,
            decision,
        }) => {
            const admitted = plan.routeConstraints.allowedBackends.includes('native-append')
                && !plan.routeConstraints.forceRewrite
                && resolved.nativeCapabilities !== undefined
                && resolved.dirtyState !== undefined
                && resolved.documentStructure !== undefined
                && resolved.saveFlowMode === 'save'
                && resolved.nativeCapabilities.hasNativePdfMutationCapability
                && !resolved.includeManagedShapesForLiveSource;

            if (decision.route === 'native-append') {
                expect(admitted).toBe(true);
                expect(Object.keys(decision.nativeMutationProjection.mutations).length).toBeGreaterThan(0);
            } else if (!admitted) {
                expect(decision.route).not.toBe('native-append');
            }
        }), {numRuns: 400});
    });

    it('never grants replayable annotation mutations outside the source-replay route', () => {
        fc.assert(fc.property(ROUTE_DECISION_ARBITRARY, ({decision}) => {
            if (decision.route !== 'native-append') {
                return;
            }
            expect(decision.replayableAnnotationMutationsAllowed).toBe(
                decision.annotationRoute.route === 'source-replay',
            );
        }), {numRuns: 400});
    });

    it('never falls back after granting native append', () => {
        fc.assert(fc.property(ROUTE_DECISION_ARBITRARY, ({decision}) => {
            if (decision.route !== 'native-append') {
                return;
            }
            expect(decision.fallback.nativeRejection).toBe('native-write-failed');
            expect(Object.keys(decision.nativeMutationProjection.mutations).length).toBeGreaterThan(0);
        }), {numRuns: 400});
    });
});
