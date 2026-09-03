import {
    computed,
    ref,
    shallowRef,
} from 'vue';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfViewerSaveTransaction } from '@app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction';
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {requireDocumentRevisionToken} from '@contracts';
import {
    AnnotationReopenVerificationError,
    buildSerializationPlan,
} from '@app/modules/pdf-viewer/serialization/serializationPlan';
import { BrowserLogger } from '@app/utils/browserLogger';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { getPdfjsEditorFacadeState } from '@app/modules/pdf-viewer/engine/annotations/bridge/getPdfjsEditorFacadeState';

vi.mock(
    '@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/bindCanonicalAnnotationIdentitiesOffThread',
    () => ({bindCanonicalAnnotationIdentitiesOffThread: vi.fn(async (data: Uint8Array) => ({
        data,
        identityBindings: [],
    }))}),
);

describe('usePdfViewerSaveTransaction', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns a typed native-required failure before reading bytes for a path-backed classifier rejection', async () => {
        const saveDocument = vi.fn(async () => new Uint8Array([1]));
        const getSourcePdfData = vi.fn(async () => new Uint8Array([2]));
        const serializePdfForSave = vi.fn(async (data: Uint8Array) => data);
        const {runSaveTransaction} = usePdfViewerSaveTransaction({materializePdfJsDocumentForInternalUse: saveDocument});

        const result = await runSaveTransaction({
            mode: 'persist',
            workingPath: '/tmp/work.pdf',
            source: {
                getSourcePdfData,
                serializePdfForSave,
            },
            nativeCapabilities: {
                hasNativePdfMutationCapability: false,
                canPersistNativeMetadataMutations: false,
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
                totalPages: 1,
            },
            serializeResult: true,
        });

        expect(result.source).toBe('native-required-failure');
        expect(result.nativeRequiredFailure).toEqual({
            code: 'native-save-required',
            phase: 'pre-write',
            reason: 'missing-native-capability',
            nativeRejection: 'native-save-capability-unavailable',
        });
        expect(result.executeFallback).toBeUndefined();
        expect(saveDocument).not.toHaveBeenCalled();
        expect(getSourcePdfData).not.toHaveBeenCalled();
        expect(serializePdfForSave).not.toHaveBeenCalled();
    });

    it('serializes the synchronous canonical frontier and CAS-preserves a newer mutation', async () => {
        const application = new AnnotationApplication('save-transaction-document');
        const created = application.store.createNote({
            kind: 'note',
            identity: {id: asAnnotationId('save-transaction-note')},
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            contents: 'canonical before PDF.js projection',
            position: {
                left: 0.1,
                top: 0.2,
                width: 0.01,
                height: 0.01,
            },
            color: '#ffcc00',
            open: false,
        });
        const events: string[] = [];
        const bytes = new Uint8Array([
            7,
            8,
            9,
        ]);
        const { runSaveTransaction } = usePdfViewerSaveTransaction({
            annotationApplication: shallowRef(application),
            documentRevisionToken: computed(() => requireDocumentRevisionToken('revision-1')),
            flushAnnotationMutationsForSave: async () => {
                expect(application.store.get(created.identity.id)).toMatchObject({contents: 'canonical before PDF.js projection'});
                events.push('pdfjs-projection');
            },
            materializePdfJsDocumentForInternalUse: async () => {
                events.push('pdfjs-materialize');
                return bytes;
            },
        });

        const result = await runSaveTransaction({mode: 'persist'});
        expect(events).toEqual([
            'pdfjs-projection',
            'pdfjs-materialize',
        ]);
        expect(result.source).toBe('pdfjs-materialize');
        expect(
            result.serializedResult?.finalBytes
            ?? result.serializedBytes
            ?? result.baseBytes,
        ).toEqual(bytes);

        application.store.updateNote(created.identity.id, {contents: 'newer while serialized bytes publish'});
        expect(() => result.commitAnnotationSave?.()).toThrow('staleRevisionError');

        expect(application.store.get(created.identity.id)).toMatchObject({
            contents: 'newer while serialized bytes publish',
            persistedRevision: -1,
        });
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(true);
    });

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
        expect(result.nativeMutationProjection).toBeNull();
        expect(result.annotationSavePlan).toMatchObject({
            route: 'source-clean',
            reason: 'no-live-pdfjs-annotation-work',
        });
    });

    it('keeps an unchanged persisted comment marker anchor off the save plan', async () => {
        const editorKey = 'pdfjs_internal_editor_0';
        const markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.02,
            height: 0.02,
        };
        const application = new AnnotationApplication('persisted-anchor-document');
        application.store.replaceFromDocument([{
            kind: 'note',
            identity: {
                id: asAnnotationId('persisted-note'),
                pdfRef: '12R',
            },
            pageIndex: 0,
            revision: 0,
            persistedRevision: 0,
            deleted: false,
            createdAt: 1_781_000_000_000,
            modifiedAt: null,
            author: 'Tester',
            contents: 'saved note',
            position: markerRect,
            color: '#f59e0b',
            open: false,
        }], []);
        const anchorEditor = {};
        Object.assign(getPdfjsEditorFacadeState(anchorEditor), {
            canonicalAnnotationId: 'persisted-note',
            commentMarkerAnchor: true,
            pendingAnchorRect: markerRect,
        });
        const getPdfDocument = vi.fn(() => ({annotationStorage: {
            serializable: {map: new Map([[
                editorKey,
                {
                    annotationType: 3,
                    pageIndex: 0,
                    value: '\u200B',
                    popup: {
                        contents: 'saved note',
                        deleted: false,
                    },
                },
            ]])},
            modifiedIds: {ids: new Set()},
            resetModifiedIds: vi.fn(),
            getRawValue: (key: string) => key === editorKey ? anchorEditor : undefined,
        }}) as never);
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => new Uint8Array([1]));
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            annotationApplication: shallowRef(application),
            getPdfDocument,
            materializePdfJsDocumentForInternalUse,
        });

        const result = await runSaveTransaction({mode: 'persist'});

        expect(result.annotationSavePlan).toMatchObject({
            route: 'source-clean',
            reason: 'no-live-pdfjs-annotation-work',
        });
    });

    it('commits session-owned PDF.js editors exactly once before materialization', async () => {
        const commitOrRemove = vi.fn();
        const saveDocument = vi.fn(async () => new Uint8Array([4]));
        const { runSaveTransaction } = usePdfViewerSaveTransaction({
            pdfDocument: shallowRef({saveDocument} as never),
            annotationUiManager: shallowRef({commitOrRemove} as never),
        });

        const result = await runSaveTransaction({mode: 'persist'});

        expect(commitOrRemove).toHaveBeenCalledOnce();
        expect(saveDocument).toHaveBeenCalledOnce();
        expect(result.serializedBytes).toEqual(new Uint8Array([4]));
    });

    it('carries the canonical save frontier verification and commit callbacks', async () => {
        const verify = vi.fn(async () => undefined);
        const recordMaterializedIdentityBinding = vi.fn();
        const commit = vi.fn();
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            materializePdfJsDocumentForInternalUse: vi.fn(async () => new Uint8Array([1])),
            prepareAnnotationSave: () => ({
                verify,
                recordMaterializedIdentityBinding,
                commit,
            }),
        });

        const result = await runSaveTransaction({mode: 'persist'});
        await result.verifyAnnotationSave?.(new Uint8Array([2]));
        result.recordMaterializedIdentityBinding?.({
            annotationId: 'app-annotation-1',
            pdfRef: '700R0',
        });
        result.commitAnnotationSave?.();

        expect(verify).toHaveBeenCalledOnce();
        expect(recordMaterializedIdentityBinding).toHaveBeenCalledWith({
            annotationId: 'app-annotation-1',
            pdfRef: '700R0',
        });
        expect(commit).toHaveBeenCalledOnce();
    });

    it('leaves a pre-overlay PDF.js identity for the post-commit parse', async () => {
        const application = new AnnotationApplication('pre-overlay-identity-document');
        const capturedId = asAnnotationId('captured-frontier');
        application.store.createNote({
            kind: 'note',
            identity: {id: capturedId},
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            contents: 'captured frontier note',
            position: {
                left: 0.1,
                top: 0.2,
                width: 0.01,
                height: 0.01,
            },
            color: '#ffcc00',
            open: false,
        });
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            annotationApplication: shallowRef(application),
            materializePdfJsDocumentForInternalUse: vi.fn(async () => new Uint8Array([1])),
        });

        const result = await runSaveTransaction({mode: 'persist'});
        const recordBinding = result.recordMaterializedIdentityBinding;
        const commitAnnotationSave = result.commitAnnotationSave;
        if (!recordBinding || !commitAnnotationSave) {
            throw new Error('Expected an annotation save transaction');
        }

        expect(() => recordBinding({
            annotationId: 'freetext-renderer-only',
            pdfRef: '9 0 R',
        })).not.toThrow();
        expect(() => recordBinding({
            annotationId: capturedId,
            pdfRef: '10 0 R',
        })).not.toThrow();
        expect(() => commitAnnotationSave()).not.toThrow();
        expect(application.store.get(asAnnotationId('freetext-renderer-only'))).toBeNull();
        expect(application.store.get(capturedId)).toMatchObject({identity: {pdfRef: '10R'}});
    });

    it('logs privacy-safe verification diagnostics before a rejected save propagates', async () => {
        const warn = vi.spyOn(BrowserLogger, 'warn').mockImplementation(() => undefined);
        const diagnostics = [{
            annotationId: 'anno_diagnostic',
            kind: 'text-markup' as const,
            reopenedKind: 'text-markup' as const,
            pageIndex: 184,
            expectedSubtype: 'Highlight',
            reopenedSubtype: 'Highlight',
            expectedText: {
                present: false,
                length: 0,
                hash: '0',
            },
            reopenedText: {
                present: false,
                length: 0,
                hash: '0',
            },
            expectedGeometryCount: 3,
            reopenedGeometryCount: 3,
            maxCoordinateDelta: 0.0007,
            worstRectIndex: 2,
            coordinateTolerance: 0.0001,
            failedFields: ['geometry'],
        }];
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            materializePdfJsDocumentForInternalUse: vi.fn(async () => new Uint8Array([1])),
            prepareAnnotationSave: () => ({
                verify: vi.fn(async () => {
                    throw new AnnotationReopenVerificationError(
                        'Annotation reopen verification failed: anno_diagnostic: markup geometry mismatch',
                        diagnostics,
                        1,
                    );
                }),
                commit: vi.fn(),
            }),
        });

        const result = await runSaveTransaction({mode: 'persist'});

        await expect(result.verifyAnnotationSave?.(new Uint8Array([2])))
            .rejects.toThrow('markup geometry mismatch');
        expect(warn).toHaveBeenCalledWith(
            'workspace',
            'Annotation reopen verification rejected the staged PDF',
            {
                failures: 1,
                describedFailures: 1,
                diagnostics,
            },
        );
    });

    it('projects a canonical editor text box to bounded native mutations', async () => {
        const note = {
            kind: 'text-box',
            identity: {id: asAnnotationId('anno_large_pdf_note')},
            pageIndex: 6,
            revision: 1,
            persistedRevision: -1,
            deleted: false,
            createdAt: 1_781_000_000_000,
            modifiedAt: null,
            author: 'Tester',
            text: 'Large PDF native note',
            rect: {
                left: 0.1,
                top: 0.2,
                width: 0.2,
                height: 0.1,
            },
            rotation: 0,
            fontSize: 16,
            color: '#ffcc00',
        } as const;
        const getSourcePdfData = vi.fn(async () => new Uint8Array([9]));
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => new Uint8Array([8]));
        const verifyPath = vi.fn(async () => undefined);
        const capturedFrontierSteps: string[] = [];
        const flushAnnotationMutationsForSave = vi.fn(async () => {
            capturedFrontierSteps.push('flush');
        });
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            pdfDocument: shallowRef({
                numPages: 2_243,
                getPage: vi.fn(async () => ({
                    rotate: 0,
                    view: [
                        0,
                        0,
                        1_000,
                        1_000,
                    ],
                    getAnnotations: vi.fn(async () => []),
                })),
            } as never),
            materializePdfJsDocumentForInternalUse,
            annotationUiManager: shallowRef({commitOrRemove: () => {
                capturedFrontierSteps.push('commit');
            }} as never),
            flushAnnotationMutationsForSave,
            prepareAnnotationSave: () => ({
                plan: buildSerializationPlan({
                    epoch: 1,
                    entityBaselineHash: 'large-pdf-note-baseline',
                    documentRevisionToken: requireDocumentRevisionToken('large-pdf-note-revision'),
                    revisions: new Map([[
                        note.identity.id,
                        note.revision,
                    ]]),
                }, [note], [note]),
                verify: vi.fn(async () => undefined),
                verifyPath,
                commit: vi.fn(),
            }),
        });

        const result = await runSaveTransaction({
            mode: 'persist',
            planOnly: true,
            source: {getSourcePdfData},
            nativeCapabilities: {
                hasNativePdfMutationCapability: true,
                canPersistNativeMetadataMutations: true,
            },
            dirtyState: {
                annotationDirty: true,
                hasAnnotationChanges: true,
                hasLivePdfJsAnnotationChanges: true,
                savedPdfjsAnnotationBaselineDirty: false,
                shapeStateDirty: false,
            },
            documentStructure: {
                pageLabelsDirty: false,
                pageLabelRanges: [],
                bookmarksDirty: false,
                bookmarkItems: [],
                untitledBookmarkLabel: 'Untitled',
                totalPages: 2_243,
            },
        });

        expect(result.source).toBe('native-mutation-projection');
        expect(result.nativeMutationProjection).toMatchObject({
            phase: 'persist-native-text-box-changes',
            mutations: {textBoxes: [expect.objectContaining({
                pageIndex: 6,
                text: 'Large PDF native note',
            })]},
        });
        expect(result.verifyAnnotationSavePath).toBeTypeOf('function');
        // The classification pass owns the frontier capture because the frozen
        // plan it returns is the only plan the deferred fallback will execute.
        expect(capturedFrontierSteps).toEqual([
            'flush',
            'commit',
        ]);
        expect(getSourcePdfData).not.toHaveBeenCalled();
        expect(materializePdfJsDocumentForInternalUse).not.toHaveBeenCalled();
    });

    it('keeps a canonical text box on the native route beside materializing markup', async () => {
        const note = {
            kind: 'note',
            identity: {id: asAnnotationId('materialized-note')},
            pageIndex: 0,
            revision: 1,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: 'Tester',
            contents: 'materialized route note',
            position: {
                left: 0.7,
                top: 0.2,
                width: 0.02,
                height: 0.02,
            },
            color: '#ffcc00',
            open: false,
        } as const;
        const textBox = {
            kind: 'text-box',
            identity: {
                id: asAnnotationId('materialized-text-box'),
                pdfRef: '10R',
            },
            pageIndex: 0,
            revision: 1,
            persistedRevision: 0,
            deleted: false,
            createdAt: 1_781_000_000_000,
            modifiedAt: null,
            author: 'Tester',
            text: 'edited materialized text box',
            rect: {
                left: 0.1,
                top: 0.2,
                width: 0.2,
                height: 0.1,
            },
            rotation: 0,
            fontSize: 16,
            color: '#ffcc00',
        } as const;
        const markup = {
            kind: 'text-markup',
            identity: {id: asAnnotationId('materialized-markup')},
            pageIndex: 0,
            revision: 1,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: 1,
            author: null,
            subtype: 'Highlight',
            contents: '',
            quadPoints: [{
                left: 0.4,
                top: 0.2,
                width: 0.2,
                height: 0.1,
            }],
            color: '#ffff00',
            opacity: 1,
        } as const;
        const plan = buildSerializationPlan({
            epoch: 1,
            entityBaselineHash: 'materialized-markup-with-text-box',
            documentRevisionToken: requireDocumentRevisionToken('materialized-markup-with-text-box-revision'),
            revisions: new Map([
                [
                    note.identity.id,
                    note.revision,
                ],
                [
                    textBox.identity.id,
                    textBox.revision,
                ],
                [
                    markup.identity.id,
                    markup.revision,
                ],
            ]),
        }, [
            note,
            textBox,
            markup,
        ], [
            note,
            textBox,
            markup,
        ]);
        const getSourcePdfData = vi.fn(async () => new Uint8Array([9]));
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => new Uint8Array([8]));
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            getPdfDocument: () => ({
                annotationStorage: {
                    serializable: {map: new Map()},
                    modifiedIds: {ids: new Set()},
                    resetModifiedIds: vi.fn(),
                },
                numPages: 4,
                getPage: vi.fn(async () => ({
                    rotate: 0,
                    view: [
                        0,
                        0,
                        1_000,
                        1_000,
                    ],
                    getAnnotations: vi.fn(async () => []),
                })),
            } as never),
            materializePdfJsDocumentForInternalUse,
            prepareAnnotationSave: () => ({
                plan,
                verify: vi.fn(async () => undefined),
                commit: vi.fn(),
            }),
        });

        const result = await runSaveTransaction({
            mode: 'persist',
            planOnly: true,
            source: {getSourcePdfData},
            nativeCapabilities: {
                hasNativePdfMutationCapability: true,
                canPersistNativeMetadataMutations: true,
            },
            dirtyState: {
                annotationDirty: true,
                hasAnnotationChanges: true,
                hasLivePdfJsAnnotationChanges: true,
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
        });

        expect(result.source).toBe('native-mutation-projection');
        expect(result.annotationSavePlan).toMatchObject({
            route: 'pdfjs-materialize',
            reason: 'live-pdfjs-annotation-storage',
        });
        expect(result.nativeMutationProjection?.mutations.textBoxes).toEqual([expect.objectContaining({
            stableKey: 'materialized-text-box',
            annotationId: '10R',
            text: 'edited materialized text box',
        })]);
        expect(result.nativeMutationProjection?.mutations.freeTextNotes).toEqual([expect.objectContaining({
            stableKey: 'materialized-note',
            text: 'materialized route note',
        })]);
        expect(result.nativeMutationProjection?.mutations.markup?.hints).toEqual([expect.objectContaining({
            appAnnotationId: 'materialized-markup',
            subtype: 'Highlight',
        })]);
        expect(getSourcePdfData).not.toHaveBeenCalled();
        expect(materializePdfJsDocumentForInternalUse).not.toHaveBeenCalled();
    });

    it('keeps a restored Cyrillic popup note on the bounded native route', async () => {
        const note = {
            kind: 'text-box',
            identity: {id: asAnnotationId('anno_restored_popup_note')},
            pageIndex: 0,
            revision: 1,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            text: 'фвыафыва',
            rect: {
                left: 0.1,
                top: 0.2,
                width: 0.02,
                height: 0.02,
            },
            rotation: 0,
            fontSize: 16,
            color: '#ffcc00',
        } as const;
        const annotationStorage = {
            serializable: {
                map: new Map(),
                hash: 'restored-unicode-popup-note',
            },
            modifiedIds: {ids: new Set()},
            resetModifiedIds: vi.fn(),
        };
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => new Uint8Array([8]));
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            pdfDocument: shallowRef({
                annotationStorage,
                numPages: 882,
                getPage: vi.fn(async () => ({
                    getAnnotations: vi.fn(async () => [{id: '8909R'}]),
                    rotate: 0,
                    view: [
                        0,
                        0,
                        1_000,
                        1_000,
                    ],
                })),
            } as never),
            annotationUiManager: shallowRef({commitOrRemove: vi.fn()} as never),
            materializePdfJsDocumentForInternalUse,
            prepareAnnotationSave: () => ({
                plan: buildSerializationPlan({
                    epoch: 1,
                    entityBaselineHash: 'restored-unicode-popup-baseline',
                    documentRevisionToken: requireDocumentRevisionToken('restored-unicode-popup-revision'),
                    revisions: new Map([[
                        note.identity.id,
                        note.revision,
                    ]]),
                }, [note], [note]),
                verify: vi.fn(async () => undefined),
                verifyPath: vi.fn(async () => undefined),
                commit: vi.fn(),
            }),
        });

        const result = await runSaveTransaction({
            mode: 'persist',
            planOnly: true,
            source: {getSourcePdfData: vi.fn(async () => new Uint8Array([9]))},
            nativeCapabilities: {
                hasNativePdfMutationCapability: true,
                canPersistNativeMetadataMutations: true,
            },
            dirtyState: {
                annotationDirty: true,
                hasAnnotationChanges: true,
                hasLivePdfJsAnnotationChanges: true,
                savedPdfjsAnnotationBaselineDirty: false,
                shapeStateDirty: false,
            },
            documentStructure: {
                pageLabelsDirty: false,
                pageLabelRanges: [],
                bookmarksDirty: false,
                bookmarkItems: [],
                untitledBookmarkLabel: 'Untitled',
                totalPages: 882,
            },
        });

        expect(result.source).toBe('native-mutation-projection');
        expect(result.nativeMutationProjection).toMatchObject({
            phase: 'persist-native-text-box-changes',
            mutations: {textBoxes: [expect.objectContaining({
                pageIndex: 0,
                text: 'фвыафыва',
            })]},
        });
        expect(materializePdfJsDocumentForInternalUse).not.toHaveBeenCalled();
    });

    it('projects a new PDF.js FreeText box to bounded native mutations', async () => {
        const editor = {
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
        };
        const serializableMap = new Map([[
            'pdfjs_internal_editor_0',
            editor,
        ]]);
        const annotationStorage = {
            serializable: {
                map: serializableMap,
                hash: 'recorded-large-pdf-free-text-box',
            },
            modifiedIds: {ids: new Set([null])},
            resetModifiedIds: vi.fn(),
        };
        const getSourcePdfData = vi.fn(async () => new Uint8Array([9]));
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => new Uint8Array([8]));
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            pdfDocument: shallowRef({
                annotationStorage,
                numPages: 882,
            } as never),
            annotationUiManager: shallowRef({commitOrRemove: vi.fn()} as never),
            materializePdfJsDocumentForInternalUse,
        });

        const result = await runSaveTransaction({
            mode: 'persist',
            planOnly: true,
            source: {getSourcePdfData},
            nativeCapabilities: {
                hasNativePdfMutationCapability: true,
                canPersistNativeMetadataMutations: true,
            },
            dirtyState: {
                annotationDirty: true,
                hasAnnotationChanges: true,
                hasLivePdfJsAnnotationChanges: true,
                savedPdfjsAnnotationBaselineDirty: false,
                shapeStateDirty: false,
            },
            documentStructure: {
                pageLabelsDirty: false,
                pageLabelRanges: [],
                bookmarksDirty: false,
                bookmarkItems: [],
                untitledBookmarkLabel: 'Untitled',
                totalPages: 882,
            },
        });

        expect(result.source).toBe('native-mutation-projection');
        expect(result.nativeMutationProjection).toMatchObject({
            phase: 'persist-native-free-text-editor-changes',
            mutations: {freeTextEditors: [{
                pageIndex: 854,
                stableKey: expect.stringMatching(/^freetext-[0-9a-f-]{36}$/u),
                rect: editor.rect,
                rotation: 0,
                color: editor.color,
                fontSize: 16,
                text: 'asdfadf',
            }]},
        });
        expect(getSourcePdfData).not.toHaveBeenCalled();
        expect(materializePdfJsDocumentForInternalUse).not.toHaveBeenCalled();
    });

    it('keeps Cyrillic FreeText on the lossless PDF.js materialization route', async () => {
        const annotationStorage = {
            serializable: {
                map: new Map([[
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
                ]]),
                hash: 'unicode-free-text-box',
            },
            modifiedIds: {ids: new Set([null])},
            resetModifiedIds: vi.fn(),
        };
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => new Uint8Array([8]));
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            pdfDocument: shallowRef({
                annotationStorage,
                numPages: 1,
            } as never),
            annotationUiManager: shallowRef({commitOrRemove: vi.fn()} as never),
            materializePdfJsDocumentForInternalUse,
        });

        const result = await runSaveTransaction({
            mode: 'persist',
            planOnly: true,
            source: {getSourcePdfData: vi.fn(async () => new Uint8Array([9]))},
            nativeCapabilities: {
                hasNativePdfMutationCapability: true,
                canPersistNativeMetadataMutations: true,
            },
            dirtyState: {
                annotationDirty: true,
                hasAnnotationChanges: true,
                hasLivePdfJsAnnotationChanges: true,
                savedPdfjsAnnotationBaselineDirty: false,
                shapeStateDirty: false,
            },
            documentStructure: {
                pageLabelsDirty: false,
                pageLabelRanges: [],
                bookmarksDirty: false,
                bookmarkItems: [],
                untitledBookmarkLabel: 'Untitled',
                totalPages: 1,
            },
        });

        expect(result.source).toBe('pdfjs-materialize');
        expect(result.nativeMutationProjection).toBeNull();
        expect(result.annotationSavePlan).toMatchObject({
            route: 'pdfjs-materialize',
            unreplayableLiveAnnotationIds: ['pdfjs_internal_editor_0'],
        });
        expect(materializePdfJsDocumentForInternalUse).not.toHaveBeenCalled();
    });

    it('executes the exact frozen plan and fallback identity after native decline', async () => {
        const prepareAnnotationSave = vi.fn(() => ({
            plan: buildSerializationPlan({
                epoch: 1,
                entityBaselineHash: 'frozen-native-plan',
                documentRevisionToken: requireDocumentRevisionToken('revision-frozen'),
                revisions: new Map(),
            }, []),
            verify: vi.fn(async () => undefined),
            assertCurrent: vi.fn(),
            commit: vi.fn(),
        }));
        const pageLabelRanges = [{
            startPage: 1,
            style: 'D' as const,
            prefix: 'captured-',
            startNumber: 1,
        }];
        const serializePdfForSave = vi.fn(async (data: Uint8Array) => data);
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            prepareAnnotationSave,
            materializePdfJsDocumentForInternalUse: vi.fn(async () => new Uint8Array([8])),
        });

        const planned = await runSaveTransaction({
            mode: 'persist',
            planOnly: true,
            serializeResult: true,
            source: {
                getSourcePdfData: vi.fn(async () => new Uint8Array([1])),
                serializePdfForSave,
            },
            nativeCapabilities: {
                hasNativePdfMutationCapability: true,
                canPersistNativeMetadataMutations: true,
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
                pageLabelRanges,
                bookmarksDirty: false,
                bookmarkItems: [],
                untitledBookmarkLabel: 'Untitled',
                totalPages: 3,
            },
        });
        expect(planned.source).toBe('native-mutation-projection');
        pageLabelRanges[0]!.prefix = 'mutated-after-native-decline-';

        const fallbackPromise = planned.executeFallback?.();
        expect(planned.executeFallback?.()).toBe(fallbackPromise);
        const fallback = await fallbackPromise;

        expect(fallback?.fallbackDecision).toBe(planned.fallbackDecision);
        expect(prepareAnnotationSave).toHaveBeenCalledOnce();
        expect(serializePdfForSave).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            expect.objectContaining({annotationSerializationPlan: expect.objectContaining({metadata: {
                pageLabels: [{
                    startPage: 1,
                    style: 'D',
                    prefix: 'captured-',
                    startNumber: 1,
                }],
                bookmarks: null,
            }})}),
        );
        expect(fallback?.serializedResult?.finalBytes).toEqual(new Uint8Array([1]));
    });

    it('fences the save package by application, PDF proxy, revision, and document owner', async () => {
        const application = new AnnotationApplication('currentness-document');
        const applicationRef = shallowRef(application);
        const pdfDocument = shallowRef({numPages: 3} as never);
        const revision = ref(requireDocumentRevisionToken('revision-current'));
        const fence = {
            loadToken: 1,
            documentVersion: 1,
            documentRevision: 'revision-current',
            openSurfaceGeneration: 1,
        };
        let fenceCurrent = true;
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            annotationApplication: applicationRef,
            pdfDocument,
            documentRevisionToken: computed(() => revision.value),
            documentSession: {
                captureFence: () => fence,
                isCurrent: captured => captured === fence && fenceCurrent,
            },
        });
        const request = {
            mode: 'persist' as const,
            planOnly: true,
            source: {getSourcePdfData: vi.fn(async () => new Uint8Array([1]))},
            nativeCapabilities: {
                hasNativePdfMutationCapability: true,
                canPersistNativeMetadataMutations: true,
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
                    style: 'D' as const,
                    prefix: '',
                    startNumber: 1,
                }],
                bookmarksDirty: false,
                bookmarkItems: [],
                untitledBookmarkLabel: 'Untitled',
                totalPages: 3,
            },
        };

        const revisionResult = await runSaveTransaction(request);
        revision.value = requireDocumentRevisionToken('revision-replaced');
        await expect(revisionResult.assertAnnotationSaveCurrent?.()).rejects.toThrow(/document revision changed/iu);
        revision.value = requireDocumentRevisionToken('revision-current');

        const proxyResult = await runSaveTransaction(request);
        const capturedPdfDocument = pdfDocument.value;
        pdfDocument.value = {numPages: 3} as never;
        await expect(proxyResult.assertAnnotationSaveCurrent?.()).rejects.toThrow(/PDF document changed/iu);
        pdfDocument.value = capturedPdfDocument;

        const applicationResult = await runSaveTransaction(request);
        applicationRef.value = new AnnotationApplication('replacement-document');
        await expect(applicationResult.assertAnnotationSaveCurrent?.()).rejects.toThrow(/annotation application changed/iu);
        expect(() => applicationResult.commitAnnotationSave?.()).not.toThrow();
        applicationRef.value = application;

        const fenceResult = await runSaveTransaction(request);
        fenceCurrent = false;
        await expect(fenceResult.assertAnnotationSaveCurrent?.()).rejects.toThrow(/document open fence changed/iu);
    });

    it('combines the captured canonical frontier with live PDF.js editor storage', async () => {
        const serializableMap = new Map([[
            'pdfjs-freetext-1',
            {
                annotationType: 3,
                value: 'new editor text',
            },
        ]]);
        const getPdfDocument = vi.fn(() => ({annotationStorage: {
            serializable: {
                map: serializableMap,
                hash: 'live-editor-hash',
            },
            modifiedIds: {ids: new Set(['pdfjs-freetext-1'])},
            resetModifiedIds: vi.fn(),
        }}) as never);
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => new Uint8Array([1]));
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            materializePdfJsDocumentForInternalUse,
            getPdfDocument,
            prepareAnnotationSave: () => ({
                plan: buildSerializationPlan({
                    epoch: 7,
                    entityBaselineHash: 'baseline',
                    documentRevisionToken: requireDocumentRevisionToken('revision-7'),
                    revisions: new Map(),
                }, []),
                verify: vi.fn(async () => undefined),
                commit: vi.fn(),
            }),
        });

        await expect(runSaveTransaction({
            mode: 'persist',
            source: {getSourcePdfData: vi.fn(async () => new Uint8Array([9]))},
        })).resolves.toMatchObject({annotationSavePlan: {
            route: 'pdfjs-materialize',
            reason: 'live-pdfjs-annotation-storage',
        }});
        expect(getPdfDocument).toHaveBeenCalled();
        expect(materializePdfJsDocumentForInternalUse).toHaveBeenCalledOnce();
    });

    it('preserves live editor work when commit consumes PDF.js modified bookkeeping', async () => {
        const serializableMap = new Map<string, unknown>([[
            'pdfjs-freetext-1',
            {
                annotationType: 3,
                value: 'new editor text',
            },
        ]]);
        const getPdfDocument = vi.fn(() => ({annotationStorage: {
            serializable: {
                map: serializableMap,
                hash: `${serializableMap.size}`,
            },
            modifiedIds: {ids: new Set(serializableMap.keys())},
            resetModifiedIds: vi.fn(),
        }}) as never);
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => new Uint8Array([2]));
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            materializePdfJsDocumentForInternalUse,
            getPdfDocument,
            annotationUiManager: shallowRef({commitOrRemove: () => {
                serializableMap.clear();
            }} as never),
        });

        const result = await runSaveTransaction({
            mode: 'persist',
            source: {getSourcePdfData: vi.fn(async () => new Uint8Array([1]))},
        });

        expect(result.annotationSavePlan).toMatchObject({
            route: 'pdfjs-materialize',
            reason: 'live-pdfjs-annotation-storage',
        });
        expect(materializePdfJsDocumentForInternalUse).toHaveBeenCalledOnce();
    });

    it('treats every persisted delete identity alias as covered replay work', async () => {
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => new Uint8Array([2]));
        const sourceBytes = new Uint8Array([1]);
        const deletedHighlight = {
            kind: 'text-markup',
            identity: {
                id: asAnnotationId('anno_delete_test'),
                pdfRef: '9R',
            },
            pageIndex: 0,
            revision: 1,
            persistedRevision: 0,
            deleted: true,
            createdAt: null,
            modifiedAt: 1,
            author: null,
            subtype: 'Highlight',
            contents: '',
            quadPoints: [{
                left: 0.1,
                top: 0.1,
                width: 0.2,
                height: 0.1,
            }],
            color: '#ffff00',
            opacity: 1,
        } as const;
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            materializePdfJsDocumentForInternalUse,
            getPdfDocument: vi.fn(() => ({annotationStorage: {
                serializable: {
                    map: new Map(),
                    hash: 'deleted-highlight',
                },
                modifiedIds: {ids: new Set([
                    'anno_delete_test',
                    '9R',
                ])},
                resetModifiedIds: vi.fn(),
            }}) as never),
            prepareAnnotationSave: () => ({
                plan: buildSerializationPlan({
                    epoch: 1,
                    entityBaselineHash: 'baseline',
                    documentRevisionToken: requireDocumentRevisionToken('revision-delete'),
                    revisions: new Map([[
                        asAnnotationId('anno_delete_test'),
                        1,
                    ]]),
                }, [deletedHighlight] as never, [deletedHighlight] as never),
                verify: vi.fn(async () => undefined),
                commit: vi.fn(),
            }),
        });

        const result = await runSaveTransaction({
            mode: 'persist',
            source: {getSourcePdfData: vi.fn(async () => sourceBytes)},
        });

        expect(result.annotationSavePlan).toMatchObject({
            route: 'source-replay',
            reason: 'live-pdfjs-ids-covered-by-embedded-operations',
        });
        expect(materializePdfJsDocumentForInternalUse).not.toHaveBeenCalled();
    });

    it('treats the captured dirty-state declaration as unknown live PDF.js work', async () => {
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => new Uint8Array([2]));
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            materializePdfJsDocumentForInternalUse,
            getPdfDocument: vi.fn(() => ({annotationStorage: {
                serializable: {
                    map: new Map(),
                    hash: '',
                },
                modifiedIds: {ids: new Set()},
                resetModifiedIds: vi.fn(),
            }}) as never),
        });

        const result = await runSaveTransaction({
            mode: 'persist',
            dirtyState: {
                annotationDirty: true,
                hasAnnotationChanges: true,
                hasLivePdfJsAnnotationChanges: true,
                savedPdfjsAnnotationBaselineDirty: false,
                shapeStateDirty: false,
            },
            source: {getSourcePdfData: vi.fn(async () => new Uint8Array([1]))},
        });

        expect(result.annotationSavePlan).toMatchObject({
            route: 'pdfjs-materialize',
            reason: 'unknown-live-pdfjs-annotation-storage',
        });
        expect(materializePdfJsDocumentForInternalUse).toHaveBeenCalledOnce();
    });

    it('flushes annotation mutations before committing PDF.js editors', async () => {
        const events: string[] = [];
        const { runSaveTransaction } = usePdfViewerSaveTransaction({
            flushAnnotationMutationsForSave: vi.fn(async () => {
                events.push('flush');
            }),
            annotationUiManager: shallowRef({commitOrRemove: () => {
                events.push('commit');
            }} as never),
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

    it('rejects persistence when live PDF.js editor storage changes after capture', async () => {
        const serializableMap = new Map<string, unknown>();
        const getPdfDocument = vi.fn(() => ({annotationStorage: {
            serializable: {
                map: serializableMap,
                hash: `${serializableMap.size}`,
            },
            modifiedIds: {ids: new Set(serializableMap.keys())},
            resetModifiedIds: vi.fn(),
        }}) as never);
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            materializePdfJsDocumentForInternalUse: vi.fn(async () => new Uint8Array([1])),
            getPdfDocument,
            prepareAnnotationSave: () => ({
                plan: buildSerializationPlan({
                    epoch: 1,
                    entityBaselineHash: 'baseline',
                    documentRevisionToken: requireDocumentRevisionToken('revision-1'),
                    revisions: new Map(),
                }, []),
                verify: vi.fn(async () => undefined),
                commit: vi.fn(),
            }),
        });

        const result = await runSaveTransaction({mode: 'persist'});
        serializableMap.set('late-freetext', {
            annotationType: 3,
            value: 'late edit',
        });

        await expect(result.assertAnnotationSaveCurrent?.()).rejects.toThrow(/PDF\.js annotations changed/u);
    });

    it('forces PDF.js materialization even when source bytes are available', async () => {
        const materializedBytes = new Uint8Array([
            7,
            8,
        ]);
        const getSourcePdfData = vi.fn(async () => new Uint8Array([1]));
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => materializedBytes);
        const { runSaveTransaction } = usePdfViewerSaveTransaction({materializePdfJsDocumentForInternalUse});

        const result = await runSaveTransaction({
            mode: 'persist',
            forcePdfjsMaterialize: true,
            source: {getSourcePdfData},
        });

        expect(getSourcePdfData).not.toHaveBeenCalled();
        expect(materializePdfJsDocumentForInternalUse).toHaveBeenCalledOnce();
        expect(result.source).toBe('pdfjs-materialize');
        expect(result.baseBytes).toBe(materializedBytes);
        expect(result.serializedBytes).toBeNull();
        expect(result.serializedResult).toBeNull();
        expect(result.annotationSavePlan).toMatchObject({
            route: 'pdfjs-materialize',
            reason: 'saved-pdfjs-annotation-baseline-diverged',
        });
    });

    it('serializes the selected base bytes inside the transaction when requested', async () => {
        const sourceBytes = new Uint8Array([
            1,
            2,
        ]);
        const finalBytes = new Uint8Array([
            3,
            4,
        ]);
        const getSourcePdfData = vi.fn(async () => sourceBytes);
        const serializePdfForSave = vi.fn(async () => finalBytes);
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => new Uint8Array([9]));
        const { runSaveTransaction } = usePdfViewerSaveTransaction({materializePdfJsDocumentForInternalUse});

        const result = await runSaveTransaction({
            mode: 'persist',
            saveMode: 'save_as_rewrite',
            source: {
                getSourcePdfData,
                serializePdfForSave,
            },
            serializeResult: true,
            forceRewrite: true,
            includeManagedShapes: true,
            rewriteShapeState: true,
        });

        expect(materializePdfJsDocumentForInternalUse).not.toHaveBeenCalled();
        expect(serializePdfForSave).toHaveBeenCalledWith(sourceBytes, expect.objectContaining({
            includeShapes: true,
            rewriteShapeState: true,
            forceRewrite: true,
            annotationSerializationPlan: expect.objectContaining({
                sourceEpoch: 0,
                mutationOrder: expect.any(Array),
            }),
        }));
        expect(result.source).toBe('serialized-rewrite');
        expect(result.baseBytes).toBeNull();
        expect(result.serializedBytes).toBeNull();
        expect(result.serializedResult).toEqual({
            finalBytes,
            saveMode: 'save_as_rewrite',
            source: 'serialized-rewrite',
            changedObjectRefs: [],
        });
    });

    it('retains only the canonical result when serialization returns its input allocation', async () => {
        const sourceBytes = new Uint8Array([
            1,
            2,
        ]);
        const {runSaveTransaction} = usePdfViewerSaveTransaction({materializePdfJsDocumentForInternalUse: vi.fn(async () => new Uint8Array([9]))});

        const result = await runSaveTransaction({
            mode: 'persist',
            source: {
                getSourcePdfData: vi.fn(async () => sourceBytes),
                serializePdfForSave: vi.fn(async data => data),
            },
            serializeResult: true,
        });

        expect(result.baseBytes).toBeNull();
        expect(result.serializedBytes).toBeNull();
        expect(result.serializedResult?.finalBytes).toBe(sourceBytes);
    });

    it('awaits the managed-shape baseline before any rewrite source is sampled', async () => {
        const baseline = Promise.withResolvers<boolean>();
        const getSourcePdfData = vi.fn(async () => new Uint8Array([1]));
        const ensureManagedShapeBaselineReady = vi.fn(() => baseline.promise);
        const { runSaveTransaction } = usePdfViewerSaveTransaction({
            materializePdfJsDocumentForInternalUse: vi.fn(async () => new Uint8Array([2])),
            ensureManagedShapeBaselineReady,
        });

        const transaction = runSaveTransaction({
            mode: 'print',
            serializeResult: true,
            includeManagedShapes: true,
            rewriteShapeState: true,
            source: {
                getSourcePdfData,
                serializePdfForSave: vi.fn(async data => data),
            },
        });
        await Promise.resolve();

        expect(ensureManagedShapeBaselineReady).toHaveBeenCalledOnce();
        expect(getSourcePdfData).not.toHaveBeenCalled();

        baseline.resolve(true);
        await transaction;
        expect(getSourcePdfData).toHaveBeenCalledOnce();
    });
});
