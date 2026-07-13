import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfViewerSaveTransaction } from '@app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction';
import {requireDocumentRevisionToken} from '@contracts';
import {buildSerializationPlan} from '@app/modules/pdf-viewer/serialization/serializationPlan';
import {asAnnotationId} from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';

describe('usePdfViewerSaveTransaction', () => {
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

    it('carries the canonical save frontier verification and commit callbacks', async () => {
        const verify = vi.fn(async () => undefined);
        const commit = vi.fn();
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            materializePdfJsDocumentForInternalUse: vi.fn(async () => new Uint8Array([1])),
            prepareAnnotationSave: () => ({
                verify,
                commit,
            }),
        });

        const result = await runSaveTransaction({mode: 'persist'});
        await result.verifyAnnotationSave?.(new Uint8Array([2]));
        result.commitAnnotationSave?.();

        expect(verify).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenCalledOnce();
    });

    it('projects a canonical editor FreeText note to bounded native mutations', async () => {
        const note = {
            kind: 'sticky-note',
            identity: {
                id: asAnnotationId('anno_large_pdf_note'),
                elementId: 'pdfjs_internal_editor_0',
            },
            pageIndex: 6,
            revision: 1,
            persistedRevision: -1,
            deleted: false,
            createdAt: 1_781_000_000_000,
            modifiedAt: null,
            author: 'Tester',
            text: 'Large PDF native note',
            anchor: {
                left: 0.1,
                top: 0.2,
                width: 0.2,
                height: 0.1,
            },
            color: '#ffcc00',
        } as const;
        const getSourcePdfData = vi.fn(async () => new Uint8Array([9]));
        const materializePdfJsDocumentForInternalUse = vi.fn(async () => new Uint8Array([8]));
        const verifyPath = vi.fn(async () => undefined);
        let editorWasCommitted = false;
        const commitPdfEditorsForSave = vi.fn(async () => {
            editorWasCommitted = true;
        });
        const flushAnnotationMutationsForSave = vi.fn(async () => undefined);
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            materializePdfJsDocumentForInternalUse,
            commitPdfEditorsForSave,
            flushAnnotationMutationsForSave,
            prepareAnnotationSave: () => ({
                // Mirrors the authoritative sync after PDF.js removes a
                // committed transient editor from the live editor snapshot.
                plan: buildSerializationPlan({
                    epoch: 1,
                    entityBaselineHash: 'large-pdf-note-baseline',
                    documentRevisionToken: requireDocumentRevisionToken('large-pdf-note-revision'),
                    revisions: new Map([[
                        note.identity.id,
                        note.revision,
                    ]]),
                }, editorWasCommitted ? [] : [note], [{
                    ...note,
                    deleted: editorWasCommitted,
                }]),
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
            phase: 'persist-native-note-changes',
            mutations: {freeTextNotes: [expect.objectContaining({
                pageIndex: 6,
                text: 'Large PDF native note',
            })]},
        });
        expect(result.verifyAnnotationSavePath).toBeTypeOf('function');
        expect(flushAnnotationMutationsForSave).not.toHaveBeenCalled();
        expect(commitPdfEditorsForSave).not.toHaveBeenCalled();
        expect(getSourcePdfData).not.toHaveBeenCalled();
        expect(materializePdfJsDocumentForInternalUse).not.toHaveBeenCalled();
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
            commitPdfEditorsForSave: vi.fn(async () => {
                serializableMap.clear();
            }),
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
                id: 'anno_delete_test',
                pdfRef: '9R',
                pdfjsUid: 'pdfjs_internal_editor_0',
            },
            pageIndex: 0,
            revision: 1,
            persistedRevision: 0,
            deleted: true,
            createdAt: null,
            modifiedAt: 1,
            author: null,
            subtype: 'Highlight',
            text: '',
            geometry: [{
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
                    'pdfjs_internal_editor_0',
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
            commitPdfEditorsForSave: vi.fn(async () => {
                events.push('commit');
            }),
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
        expect(result.baseBytes).toBe(sourceBytes);
        expect(result.serializedBytes).toBe(finalBytes);
        expect(result.serializedResult).toEqual({
            finalBytes,
            saveMode: 'save_as_rewrite',
            source: 'serialized-rewrite',
            changedObjectRefs: [],
        });
    });

    it('awaits the managed-shape baseline before any rewrite source is sampled', async () => {
        const baseline = Promise.withResolvers<undefined>();
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

        baseline.resolve(undefined);
        await transaction;
        expect(getSourcePdfData).toHaveBeenCalledOnce();
    });
});
