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
import type { AnnotationEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {IShapeAnnotation} from '@app/types/annotations';
import { asAnnotationId } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type { ISerializationPlanInputs } from '@app/modules/pdf-viewer/serialization/serializationPlan';
import { buildSerializationPlan } from '@app/modules/pdf-viewer/serialization/serializationPlan';
import { requireDocumentRevisionToken } from '@contracts';

const MARKER_RECT = {
    left: 0.1,
    top: 0.2,
    width: 0.2,
    height: 0.1,
};

function embeddedNote(id: string, pdfRef: string): AnnotationEntity {
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

function editorMarkup(id: string): AnnotationEntity {
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

function deletedMarkup(id: string, pdfRef: string): AnnotationEntity {
    return {
        ...editorMarkup(id),
        identity: {
            id: asAnnotationId(id),
            pdfRef,
        },
        deleted: true,
    };
}

function embeddedMarkup(id: string, pdfRef: string): AnnotationEntity {
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
            shapes: {shapes: [expect.objectContaining({id: 'shape-1'})]},
            markup: {overrides: [[
                '44R',
                'Underline',
            ]]},
        });
    });

    it('classifies an unprojectable PDF-backed FreeText edit before granting a route', () => {
        const decision = classifyPdfSaveRoute(
            planOf([embeddedNote('anno_note', '12R')]),
            capabilities(),
        );

        expect(decision.route).toBe('source-replay');
        if (decision.route === 'native-append') throw new Error('expected a byte route');
        expect(decision.nativeRejection).toBe('pending-texts-not-covered-by-native-mutations');
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
