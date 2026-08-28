import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { PDF_SAVE_TIMEOUT_MS } from '@app/constants/timeouts';
import { cast } from '@tests/helpers/cast';
import {
    createDeferred,
    createDeps,
    createEditorFreeTextNote,
    createPdfNoteComment,
    createShapeAnnotation,
    expectWorkspaceSaveMarked,
    expectWorkspaceSaveNotMarked,
    TEST_BROWSER_WORKING_COPY_REF,
    toastAddMock,
    useWorkspaceSaveServiceForTest,
} from '@tests/unit/app/modules/workspace-shell/composables/file-operations/workspaceSaveServiceFixture';

type TSaveFixtureOverrides = Parameters<typeof createDeps>[0];
interface IStrictNativeMutationRow {
    name: string;
    configure: () => TSaveFixtureOverrides;
    expectedMutationKeys: readonly string[];
}
type TStrictNativeFailureMode = 'missing' | 'success' | 'null' | 'error';
interface IStrictNativeFailureRow {
    name: string;
    nativeMode: TStrictNativeFailureMode;
    configure: () => TSaveFixtureOverrides;
    expectedNativeCalls: number;
}

describe('workspaceSaveService native persistence', () => {
    beforeEach(() => {
        toastAddMock.mockClear();
    });

    const strictNativeMutationRows: readonly IStrictNativeMutationRow[] = [
        {
            name: 'notes',
            configure: () => cast<TSaveFixtureOverrides>({
                annotationDirty: ref(true),
                canonicalAnnotationComments: shallowRef([createPdfNoteComment()]),
                captureCanonicalPendingTextUpdates: vi.fn(() => new Map([[
                    'ann:0:3856R',
                    'Updated note',
                ]])),
                hasAnnotationChanges: vi.fn(() => true),
                pdfDocument: shallowRef(null),
            }),
            expectedMutationKeys: ['updates'],
        },
        {
            name: 'editor FreeText',
            configure: () => cast<TSaveFixtureOverrides>({
                annotationDirty: ref(true),
                canonicalAnnotationComments: shallowRef([createEditorFreeTextNote()]),
                hasAnnotationChanges: vi.fn(() => true),
                pdfDocument: shallowRef(null),
            }),
            expectedMutationKeys: ['freeTextNotes'],
        },
        {
            name: 'markup',
            configure: () => cast<TSaveFixtureOverrides>({
                annotationDirty: ref(true),
                canonicalAnnotationComments: shallowRef([createPdfNoteComment({
                    id: '44R',
                    stableKey: 'ann:0:44R',
                    annotationId: '44R',
                    subtype: 'Highlight',
                    text: '',
                    color: '#22c55e',
                    colorEdited: true,
                    hasNote: false,
                    markerRect: {
                        left: 0.1,
                        top: 0.2,
                        width: 0.3,
                        height: 0.2,
                    },
                })]),
                hasAnnotationChanges: vi.fn(() => true),
                pdfDocument: shallowRef(null),
                getMarkupSubtypeHints: vi.fn(() => [{
                    annotationId: '44R',
                    id: '44R',
                    subtype: 'Highlight' as const,
                    pageIndex: 0,
                    markerRect: {
                        left: 0.1,
                        top: 0.2,
                        width: 0.3,
                        height: 0.2,
                    },
                    color: '#22c55e',
                    consumed: false,
                    pageMarkupIndex: 0,
                    source: 'pdf' as const,
                }]),
            }),
            expectedMutationKeys: ['markup'],
        },
        {
            name: 'shapes',
            configure: () => cast<TSaveFixtureOverrides>({
                annotationDirty: ref(false),
                hasShapeChanges: vi.fn(() => true),
                getAllShapes: vi.fn(() => [createShapeAnnotation()]),
                totalPages: ref(2),
            }),
            expectedMutationKeys: ['shapes'],
        },
        {
            name: 'page labels and bookmarks',
            configure: () => cast<TSaveFixtureOverrides>({
                totalPages: ref(3),
                pageLabelsDirty: ref(true),
                pageLabelRanges: ref([{
                    startPage: 1,
                    style: 'r',
                    prefix: 'intro-',
                    startNumber: 2,
                }]),
                bookmarksDirty: ref(true),
                bookmarkItems: ref([{
                    title: 'Chapter 1',
                    pageIndex: 0,
                    namedDest: null,
                    bold: false,
                    italic: false,
                    color: null,
                    items: [],
                }]),
            }),
            expectedMutationKeys: [
                'pageLabels',
                'bookmarks',
            ],
        },
        {
            name: 'mixed payload',
            configure: () => cast<TSaveFixtureOverrides>({
                annotationDirty: ref(true),
                canonicalAnnotationComments: shallowRef([createPdfNoteComment()]),
                captureCanonicalPendingTextUpdates: vi.fn(() => new Map([[
                    'ann:0:3856R',
                    'Updated note',
                ]])),
                hasAnnotationChanges: vi.fn(() => true),
                pdfDocument: shallowRef(null),
                hasShapeChanges: vi.fn(() => true),
                getAllShapes: vi.fn(() => [createShapeAnnotation()]),
                totalPages: ref(2),
                pageLabelsDirty: ref(true),
                pageLabelRanges: ref([{
                    startPage: 1,
                    style: 'D',
                    prefix: '',
                    startNumber: 1,
                }]),
            }),
            expectedMutationKeys: [
                'updates',
                'pageLabels',
                'shapes',
            ],
        },
    ];

    it.each(strictNativeMutationRows)('commits strict path-backed $name through native persistence only', async ({
        configure,
        expectedMutationKeys,
    }) => {
        const trySavePdfNativeMutations = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({
            ...configure(),
            workingCopyPath: ref('/tmp/work.pdf'),
            trySavePdfNativeMutations,
        });
        const {handleSave} = useWorkspaceSaveServiceForTest(deps);

        const result = await handleSave();
        expect(result).toBe(true);

        expect(trySavePdfNativeMutations).toHaveBeenCalledOnce();
        const nativeCall = cast<unknown[]>(trySavePdfNativeMutations.mock.calls[0]);
        const mutations = nativeCall[0];
        expectedMutationKeys.forEach(key => expect(mutations).toHaveProperty(key));
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
    });

    const strictNativeFailureRows: readonly IStrictNativeFailureRow[] = [
        {
            name: 'missing native capability',
            nativeMode: 'missing',
            configure: () => cast<TSaveFixtureOverrides>({annotationDirty: ref(true)}),
            expectedNativeCalls: 0,
        },
        {
            name: 'unknown PDF.js mutation classifier rejection',
            nativeMode: 'success',
            configure: () => cast<TSaveFixtureOverrides>({
                annotationDirty: ref(true),
                hasLivePdfJsAnnotationChanges: vi.fn(() => true),
                pdfDocument: shallowRef(cast<PDFDocumentProxy>({annotationStorage: {
                    serializable: {
                        map: new Map([[
                            'unknown-editor',
                            {value: 'unclassified'},
                        ]]),
                        hash: 'unknown-editor',
                    },
                    modifiedIds: {ids: new Set()},
                    resetModified: vi.fn(),
                }})),
            }),
            expectedNativeCalls: 0,
        },
        {
            name: 'native decline',
            nativeMode: 'null',
            configure: () => cast<TSaveFixtureOverrides>({
                totalPages: ref(1),
                pageLabelsDirty: ref(true),
                pageLabelRanges: ref([{
                    startPage: 1,
                    style: 'D',
                    prefix: '',
                    startNumber: 1,
                }]),
            }),
            expectedNativeCalls: 1,
        },
        {
            name: 'native error',
            nativeMode: 'error',
            configure: () => cast<TSaveFixtureOverrides>({
                totalPages: ref(1),
                pageLabelsDirty: ref(true),
                pageLabelRanges: ref([{
                    startPage: 1,
                    style: 'D',
                    prefix: '',
                    startNumber: 1,
                }]),
            }),
            expectedNativeCalls: 1,
        },
    ];

    it.each(strictNativeFailureRows)('rejects strict path-backed $name before renderer fallback', async ({
        nativeMode,
        configure,
        expectedNativeCalls,
    }) => {
        const trySavePdfNativeMutations = nativeMode === 'missing'
            ? undefined
            : vi.fn(async () => {
                if (nativeMode === 'error') {
                    throw new Error('native persistence failed');
                }
                if (nativeMode === 'null') {
                    return null;
                }
                return {
                    success: true,
                    outPath: '/tmp/work.pdf',
                    saveMode: 'rewrite' as const,
                    didSaveAs: false,
                };
            });
        const {
            deps,
            saveFile,
        } = createDeps({
            ...configure(),
            workingCopyPath: ref('/tmp/work.pdf'),
            ...(trySavePdfNativeMutations ? {trySavePdfNativeMutations} : {}),
        });
        const {handleSave} = useWorkspaceSaveServiceForTest(deps);

        await expect(handleSave()).resolves.toBe(false);

        const nativeCallSpy = trySavePdfNativeMutations ?? vi.fn();
        expect(nativeCallSpy).toHaveBeenCalledTimes(expectedNativeCalls);
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.save',
            description: 'errors.save.notCompleted',
        }));
    });

    const strictSerializedRouteRows = [
        {
            name: 'dirty Save As',
            invoke: (service: ReturnType<typeof useWorkspaceSaveServiceForTest>) => service.handleSaveAs(),
        },
        {
            name: 'dirty repair',
            invoke: (service: ReturnType<typeof useWorkspaceSaveServiceForTest>) => service.handleRepairSave(),
        },
        {
            name: 'dirty optimize',
            invoke: (service: ReturnType<typeof useWorkspaceSaveServiceForTest>) => service.handleOptimizePdfForInteraction(),
        },
    ] as const;

    it.each(strictSerializedRouteRows)('rejects $name on a native path before renderer serialization', async ({invoke}) => {
        const repairWorkingCopy = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const optimizeWorkingCopy = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
            saveWorkingCopyAs,
        } = createDeps({
            annotationDirty: ref(true),
            workingCopyPath: ref('/tmp/work.pdf'),
            repairWorkingCopy,
            optimizeWorkingCopy,
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(invoke(service)).resolves.toBe(false);

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(saveWorkingCopyAs).not.toHaveBeenCalled();
        expect(repairWorkingCopy).not.toHaveBeenCalled();
        expect(optimizeWorkingCopy).not.toHaveBeenCalled();
        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.save',
            description: 'errors.save.notCompleted',
        }));
    });

    it('uses the native PDF mutation path for dirty managed shapes', async () => {
        const trySavePdfNativeMutations = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const savedBytes = new Uint8Array([
            7,
            8,
            9,
        ]);
        const {
            deps,
            saveFile,
        } = createDeps({
            totalPages: ref(2),
            hasShapeChanges: vi.fn(() => true),
            getAllShapes: vi.fn(() => [createShapeAnnotation()]),
            getDeletedEmbeddedShapeAnnotationIds: vi.fn(() => ['44R']),
            getDeletedEmbeddedShapeStableKeys: vi.fn(() => ['evb-shape:deleted']),
            trySavePdfNativeMutations,
            getSourcePdfData: vi.fn(async () => savedBytes),
            preparePersistedShapeStateForSave: vi.fn(async () => ({snapshot: true})),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySavePdfNativeMutations).toHaveBeenCalledWith(
            {shapes: {
                totalPages: 2,
                rewriteShapeState: true,
                shapes: [expect.objectContaining({
                    id: 'shape-1',
                    type: 'rectangle',
                    pageIndex: 0,
                    stableKey: 'evb-shape:shape-1',
                    color: '#336699',
                    fillColor: '#abcdef',
                })],
                deletedAnnotationIds: ['44R'],
                deletedStableKeys: ['evb-shape:deleted'],
            }},
            expect.objectContaining({
                saveMode: 'rewrite',
                expectedWorkingPath: TEST_BROWSER_WORKING_COPY_REF,
                expectedDocumentRevisionToken: 'rev-1',
                preserveLoadedSource: true,
            }),
        );
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.preparePersistedShapeStateForSave).toHaveBeenCalledWith(savedBytes);
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(deps.markShapeStateSaved).toHaveBeenCalledOnce();
    });

    it.each([
        {
            name: 'native index success',
            prepared: {snapshot: true},
            expectMarked: true,
        },
        {
            name: 'native index failure',
            prepared: null,
            expectMarked: false,
        },
    ])('keeps dirty native shapes off the renderer byte path after $name', async ({
        prepared,
        expectMarked,
    }) => {
        const trySavePdfNativeMutations = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const getSourcePdfData = vi.fn(async () => {
            throw new Error('whole-document shape reads are forbidden');
        });
        const preparePersistedShapeStateForSave = vi.fn(async (_data?: Uint8Array) => prepared);
        const {
            deps,
            saveFile,
        } = createDeps({
            totalPages: ref(2),
            workingCopyPath: ref('/tmp/work.pdf'),
            hasShapeChanges: vi.fn(() => true),
            getAllShapes: vi.fn(() => [createShapeAnnotation()]),
            trySavePdfNativeMutations,
            getSourcePdfData,
            preparePersistedShapeStateForSave,
        });
        const {handleSave} = useWorkspaceSaveServiceForTest(deps);

        await expect(handleSave()).resolves.toBe(true);

        expect(trySavePdfNativeMutations).toHaveBeenCalledOnce();
        expect(preparePersistedShapeStateForSave).toHaveBeenCalledWith();
        expect(getSourcePdfData).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        if (expectMarked) {
            expect(deps.markShapeStateSaved).toHaveBeenCalledOnce();
        } else {
            expect(deps.markShapeStateSaved).not.toHaveBeenCalled();
            expect(deps.adoptPersistedShapeStateForNextReload).not.toHaveBeenCalled();
        }
    });

    it('keeps a committed native shape save successful when saved bytes cannot be reread', async () => {
        const trySavePdfNativeMutations = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const getSourcePdfData = vi.fn(async () => {
            throw new RangeError('Document allocation size exceeds the renderer admission ceiling');
        });
        const {
            deps,
            saveFile,
        } = createDeps({
            totalPages: ref(2),
            hasShapeChanges: vi.fn(() => true),
            getAllShapes: vi.fn(() => [createShapeAnnotation()]),
            trySavePdfNativeMutations,
            getSourcePdfData,
        });
        const {handleSave} = useWorkspaceSaveServiceForTest(deps);

        await expect(handleSave()).resolves.toBe(true);

        expect(trySavePdfNativeMutations).toHaveBeenCalledOnce();
        expect(getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.preparePersistedShapeStateForSave).not.toHaveBeenCalled();
        expect(deps.markShapeStateSaved).not.toHaveBeenCalled();
        expect(deps.adoptPersistedShapeStateForNextReload).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
        expect(toastAddMock).not.toHaveBeenCalled();
    });

    it('falls back to serialized save when dirty shapes are not native-eligible', async () => {
        const trySavePdfNativeMutations = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({
            totalPages: ref(1),
            hasShapeChanges: vi.fn(() => true),
            getAllShapes: vi.fn(() => [createShapeAnnotation({x: 1.2})]),
            trySavePdfNativeMutations,
            getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySavePdfNativeMutations).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(saveFile).toHaveBeenCalledOnce();
    });

    it('falls back to serialized save for metadata when generic native mutations are unavailable', async () => {
        const {
            deps,
            saveFile,
        } = createDeps({
            totalPages: ref(3),
            pageLabelsDirty: ref(true),
            pageLabelRanges: ref([{
                startPage: 1,
                style: 'r',
                prefix: '',
                startNumber: 1,
            }]),
            trySaveEmbeddedNoteTextUpdates: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/work.pdf',
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            })),
            getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(deps.trySaveEmbeddedNoteTextUpdates).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(saveFile).toHaveBeenCalledOnce();
    });

    it('fails the save instead of falling back when native staged commit persistence rejects', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const trySavePdfNativeMutations = vi.fn(async () => {
            throw new Error('Staged artifact content changed after staging');
        });
        const {
            deps,
            saveFile,
        } = createDeps({
            totalPages: ref(3),
            pageLabelsDirty: ref(true),
            pageLabelRanges: ref([{
                startPage: 1,
                style: 'D',
                prefix: '',
                startNumber: 1,
            }]),
            trySavePdfNativeMutations,
        });
        const {handleSave} = useWorkspaceSaveServiceForTest(deps);

        await expect(handleSave()).resolves.toBe(false);

        expect(trySavePdfNativeMutations).toHaveBeenCalledOnce();
        expect(saveFile).not.toHaveBeenCalled();
        expectWorkspaceSaveNotMarked(deps);
    });

    it('materializes a saved PDF.js baseline even when replayable editor-only FreeText deletes exist', async () => {
        const pendingDeletes = [createEditorFreeTextNote()];
        const trySaveEmbeddedNoteTextUpdates = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            canonicalAnnotationComments: ref([]),
            captureCanonicalPendingAnnotationDeletes: vi.fn(() => pendingDeletes),
            hasAnnotationChanges: vi.fn(() => true),
            hasSavedPdfJsAnnotationBaselineChanges: vi.fn(() => true),
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const result = await handleSave();

        expect(result).toBe(true);
        expect(trySaveEmbeddedNoteTextUpdates).not.toHaveBeenCalled();
        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(saveFile).toHaveBeenCalledOnce();
    });

    it('does not use the native note text save path for Save As', async () => {
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Updated note');
        const trySaveEmbeddedNoteTextUpdates = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveWorkingCopyAs,
        } = createDeps({
            annotationDirty: ref(true),
            canonicalAnnotationComments: ref([createPdfNoteComment()]),
            captureCanonicalPendingTextUpdates: vi.fn(() => pendingTexts),
            trySaveEmbeddedNoteTextUpdates,
        });
        const { handleSaveAs } = useWorkspaceSaveServiceForTest(deps);

        const result = await handleSaveAs();

        expect(result).toBe(true);
        expect(trySaveEmbeddedNoteTextUpdates).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(saveWorkingCopyAs).toHaveBeenCalledOnce();
    });

    it('uses PDF.js saveDocument when annotation storage has serializable entries without modified ids', async () => {
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage: {
            resetModified: vi.fn(),
            modifiedIds: { ids: new Set() },
            serializable: {
                map: new Map([[
                    'ink-editor-1',
                    { path: 'M0 0L1 1' },
                ]]),
                hash: 'ink-hash',
                transfer: [],
            },
        } }));
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            pdfDocument: livePdfDocument,
            saveDocument: vi.fn(async () => new Uint8Array([11])),
            getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await handleSave();

        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.getSourcePdfData).not.toHaveBeenCalled();
        expect(Array.from(saveFile.mock.calls[0]?.[0] ?? [])).toEqual([
            11,
            2,
            3,
            6,
            4,
            5,
        ]);
    });

    it('waits for the post-save reload after clearing the visible save indicator', async () => {
        const deferredReload = createDeferred<undefined>();
        const cancel = vi.fn();
        const {
            deps,
            resetModified,
        } = createDeps({
            annotationDirty: ref(true),
            pageLabelsDirty: ref(true),
            hasShapeChanges: vi.fn(() => true),
            preparePostSaveReload: () => ({
                promise: deferredReload.promise,
                cancel,
            }),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        let settled = false;
        const savePromise = handleSave().then(() => {
            settled = true;
        });

        await vi.waitFor(() => {
            expect(deps.saveFile).toHaveBeenCalledOnce();
        });
        expect(settled).toBe(false);
        expect(cancel).not.toHaveBeenCalled();
        await vi.waitFor(() => {
            expect(deps.isSaving.value).toBe(false);
        });
        expect(deps.saveFile).toHaveBeenCalledOnce();
        expect(resetModified).not.toHaveBeenCalled();
        expectWorkspaceSaveNotMarked(deps);
        const adoptPersistedShapeStateForNextReload = vi.mocked(
            deps.adoptPersistedShapeStateForNextReload!,
        );
        const saveFile = vi.mocked(deps.saveFile);
        expect(adoptPersistedShapeStateForNextReload).toHaveBeenCalledOnce();
        expect(
            adoptPersistedShapeStateForNextReload.mock.invocationCallOrder[0],
        ).toBeLessThan(saveFile.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);

        deferredReload.resolve(undefined);
        await savePromise;

        expect(settled).toBe(true);
        expect(resetModified).toHaveBeenCalledOnce();
        expectWorkspaceSaveMarked(deps);
    });

    it('arms persisted shape adoption before the save mutates the working copy bytes', async () => {
        const saveOrder: string[] = [];
        const { deps } = createDeps({
            annotationDirty: ref(true),
            hasShapeChanges: vi.fn(() => true),
            adoptPersistedShapeStateForNextReload: vi.fn(() => {
                saveOrder.push('adopt');
            }),
            saveFile: vi.fn(async () => {
                saveOrder.push('save-file');
                return {
                    success: true,
                    outPath: '/tmp/work.pdf',
                    saveMode: 'rewrite' as const,
                    didSaveAs: false,
                };
            }),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await handleSave();

        expect(saveOrder.slice(0, 2)).toEqual([
            'adopt',
            'save-file',
        ]);
    });

    it('prepares persisted managed shape state from the saved bytes before save mutates the working copy', async () => {
        const saveOrder: string[] = [];
        const { deps } = createDeps({
            annotationDirty: ref(true),
            hasShapeChanges: vi.fn(() => true),
            preparePersistedShapeStateForSave: vi.fn(async () => {
                saveOrder.push('prepare');
                return { snapshot: true };
            }),
            adoptPersistedShapeStateForNextReload: vi.fn(() => {
                saveOrder.push('adopt');
            }),
            saveFile: vi.fn(async () => {
                saveOrder.push('save-file');
                return {
                    success: true,
                    outPath: '/tmp/work.pdf',
                    saveMode: 'rewrite' as const,
                    didSaveAs: false,
                };
            }),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await handleSave();

        expect(saveOrder.slice(0, 3)).toEqual([
            'prepare',
            'adopt',
            'save-file',
        ]);
        const preparePersistedShapeStateForSave = deps.preparePersistedShapeStateForSave!;
        expect(preparePersistedShapeStateForSave).toHaveBeenCalledOnce();
        const preparedBytes = vi.mocked(preparePersistedShapeStateForSave).mock.calls[0]![0];
        if (!preparedBytes) {
            throw new Error('Expected serialized shape preparation bytes');
        }
        expect(Array.from(preparedBytes)).toEqual([
            1,
            2,
            3,
            6,
            4,
            5,
        ]);
        expect(deps.restorePreparedPersistedShapeState).not.toHaveBeenCalled();
    });

    it('marks shape state saved after persistence even when the post-save reload fails to restore', async () => {
        const { deps } = createDeps({
            annotationDirty: ref(true),
            hasShapeChanges: vi.fn(() => true),
            preparePostSaveReload: () => ({
                promise: Promise.reject(new Error('reload failed')),
                cancel: vi.fn(),
            }),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await handleSave();

        expectWorkspaceSaveMarked(deps);
        expect(deps.adoptPersistedShapeStateForNextReload).toHaveBeenCalledOnce();
    });

    it('serializes shape-only annotation saves from source bytes', async () => {
        const {
            deps,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            hasShapeChanges: vi.fn(() => true),
            getSourcePdfData: vi.fn(async () => new Uint8Array([13])),
            saveDocument: vi.fn(async () => new Uint8Array([99])),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await handleSave();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(Array.from(saveFile.mock.calls[0]?.[0] ?? [])).toEqual([
            13,
            2,
            3,
            6,
            4,
            5,
        ]);
    });

    it('cancels the pending post-save reload waiter when save does not succeed', async () => {
        const deferredReload = createDeferred<undefined>();
        const cancel = vi.fn();
        const { deps } = createDeps({
            annotationDirty: ref(true),
            saveFile: vi.fn(async () => ({
                success: false,
                outPath: null,
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            })),
            preparePostSaveReload: () => ({
                promise: deferredReload.promise,
                cancel,
            }),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await handleSave();

        expect(cancel).toHaveBeenCalledOnce();
        expect(deps.markShapeStateSaved).not.toHaveBeenCalled();
        expect(deps.clearPendingPersistedShapeStateForNextReload).toHaveBeenCalledOnce();
    });

    it('restores consumed embedded annotation updates when serialized persistence fails', async () => {
        const pendingTexts = new Map<string, string>();
        pendingTexts.set('ann:0:3856R', 'Unsaved retry text');
        const pendingDeletes = [{
            id: '3856R',
            stableKey: 'ann:0:3856R',
            sortIndex: null,
            pageIndex: 0,
            pageNumber: 1,
            text: 'Unsaved retry text',
            kindLabel: 'Note',
            subtype: 'FreeText',
            author: null,
            modifiedAt: Date.now(),
            color: null,
            uid: null,
            annotationId: '3856R',
            source: 'pdf',
            hasNote: true,
            markerRect: null,
        } satisfies IAnnotationCommentSummary];
        const { deps } = createDeps({
            annotationDirty: ref(true),
            captureCanonicalPendingTextUpdates: vi.fn(() => pendingTexts),
            captureCanonicalPendingAnnotationDeletes: vi.fn(() => pendingDeletes),
            saveFile: vi.fn(async () => ({
                success: false,
                outPath: null,
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            })),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await handleSave();

        expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
    });

    it('restores the prepared managed shape state when persistence fails after priming saved bytes', async () => {
        const snapshot = { snapshot: 'prepared' };
        const { deps } = createDeps({
            annotationDirty: ref(true),
            hasShapeChanges: vi.fn(() => true),
            preparePersistedShapeStateForSave: vi.fn(async () => snapshot),
            saveFile: vi.fn(async () => ({
                success: false,
                outPath: null,
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            })),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await handleSave();

        expect(deps.preparePersistedShapeStateForSave).toHaveBeenCalledOnce();
        expect(deps.restorePreparedPersistedShapeState).toHaveBeenCalledOnce();
        expect(deps.restorePreparedPersistedShapeState).toHaveBeenCalledWith(snapshot);
        expect(deps.clearPendingPersistedShapeStateForNextReload).toHaveBeenCalledOnce();
    });

    it('keeps shape edits dirty when a serialized save persists but cannot confirm the shape baseline', async () => {
        const {
            deps,
            resetModified,
            saveFile,
        } = createDeps({
            annotationDirty: ref(true),
            hasShapeChanges: vi.fn(() => true),
            // What an oversized document does: the guard refuses the scan, so
            // the persisted shape baseline is never established.
            preparePersistedShapeStateForSave: vi.fn(async () => null),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await expect(handleSave()).resolves.toBe(true);

        // The bytes still reach disk; only the clean mark is withheld.
        expect(saveFile).toHaveBeenCalledOnce();
        expect(resetModified).toHaveBeenCalledOnce();
        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
        expect(deps.markShapeStateSaved).not.toHaveBeenCalled();
        // Nothing was primed, so nothing may be adopted on the next reload.
        expect(deps.adoptPersistedShapeStateForNextReload).not.toHaveBeenCalled();
        expect(deps.restorePreparedPersistedShapeState).not.toHaveBeenCalled();
    });

    it('hands the prepared token to the shape clean mark on a serialized save', async () => {
        const prepared = { prepared: 'serialized' };
        const { deps } = createDeps({
            annotationDirty: ref(true),
            hasShapeChanges: vi.fn(() => true),
            preparePersistedShapeStateForSave: vi.fn(async () => prepared),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await handleSave();

        expect(deps.markShapeStateSaved).toHaveBeenCalledWith(prepared);
        expect(deps.restorePreparedPersistedShapeState).not.toHaveBeenCalled();
    });

    it('hands the prepared token to the shape clean mark on a native mutation save', async () => {
        const prepared = { prepared: 'native' };
        const trySavePdfNativeMutations = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {
            deps,
            saveFile,
        } = createDeps({
            totalPages: ref(2),
            hasShapeChanges: vi.fn(() => true),
            getAllShapes: vi.fn(() => [createShapeAnnotation()]),
            trySavePdfNativeMutations,
            getSourcePdfData: vi.fn(async () => new Uint8Array([
                7,
                8,
                9,
            ])),
            preparePersistedShapeStateForSave: vi.fn(async () => prepared),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        await expect(handleSave()).resolves.toBe(true);

        // A native decline falls back to the serialized route, which marks the
        // same token clean. Only the absence of that fallback proves the token
        // came out of the native save.
        expect(trySavePdfNativeMutations).toHaveBeenCalledOnce();
        expect(saveFile).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(deps.markShapeStateSaved).toHaveBeenCalledWith(prepared);
    });

    it('cancels the pending post-save reload waiter when Save As is canceled without dirty changes', async () => {
        const deferredReload = createDeferred<undefined>();
        const cancel = vi.fn();
        const { deps } = createDeps({
            saveWorkingCopyAs: vi.fn(async () => ({
                success: false,
                outPath: null,
                saveMode: 'save_as_rewrite' as const,
                didSaveAs: true,
            })),
            preparePostSaveReload: () => ({
                promise: deferredReload.promise,
                cancel,
            }),
        });
        const { handleSaveAs } = useWorkspaceSaveServiceForTest(deps);

        await handleSaveAs();

        expect(cancel).toHaveBeenCalledOnce();
        expect(deps.markShapeStateSaved).not.toHaveBeenCalled();
        expect(deps.clearPendingPersistedShapeStateForNextReload).toHaveBeenCalledOnce();
    });

    it('surfaces a toast and stops the saving state when PDF.js saveDocument stalls', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.useFakeTimers();
        const stalledSave = new Promise<Uint8Array | null>(() => undefined);
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage: {
            resetModified: vi.fn(),
            modifiedIds: { ids: new Set(['3856R']) },
        } }));
        const { deps } = createDeps({
            annotationDirty: ref(true),
            pdfDocument: livePdfDocument,
            saveDocument: vi.fn(() => stalledSave),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        try {
            const savePromise = handleSave();
            await vi.advanceTimersByTimeAsync(0);
            expect(deps.saveDocument).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(PDF_SAVE_TIMEOUT_MS);
            await vi.advanceTimersByTimeAsync(2_000);
            await savePromise;

            expect(deps.serializePdfForSave).not.toHaveBeenCalled();
            expect(deps.saveFile).not.toHaveBeenCalled();
            expect(deps.isSaving.value).toBe(false);
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'error',
                title: 'errors.file.save',
                description: 'PDF.js saveDocument timed out',
            }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('queues a second save until the first save has acknowledged its frontier', async () => {
        const deferredNotes = createDeferred<boolean>();
        const { deps } = createDeps({
            annotationNoteWindowsCount: ref(1),
            persistAllAnnotationNotes: vi.fn(() => deferredNotes.promise),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const firstSave = handleSave();
        const secondSave = handleSave();

        await Promise.resolve();
        expect(deps.persistAllAnnotationNotes).toHaveBeenCalledOnce();
        expect(deps.isSaving.value).toBe(true);

        deferredNotes.resolve(true);
        await expect(firstSave).resolves.toBe(true);
        await expect(secondSave).resolves.toBe(true);

        expect(deps.isSaving.value).toBe(false);
        expect(deps.persistAllAnnotationNotes).toHaveBeenCalledTimes(2);
    });

    it('keeps a queued save for the same document after the first save advances its revision', async () => {
        const { deps } = createDeps();
        const saveWorkingCopy = vi.mocked(deps.saveWorkingCopy);
        saveWorkingCopy.mockImplementation(async () => {
            deps.documentRevisionToken.value = requireDocumentRevisionToken('rev-2');
            return {
                success: true,
                outPath: '/tmp/work.pdf',
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            };
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const firstSave = handleSave();
        const queuedSave = handleSave();

        await expect(firstSave).resolves.toBe(true);
        await expect(queuedSave).resolves.toBe(true);
        expect(saveWorkingCopy).toHaveBeenCalledTimes(2);
        expect(saveWorkingCopy.mock.calls[1]?.[0]).toMatchObject({expectedDocumentRevisionToken: 'rev-2'});
    });

    it('rejects a queued save when its document identity changes before execution', async () => {
        const deferredNotes = createDeferred<boolean>();
        const { deps } = createDeps({
            annotationNoteWindowsCount: ref(1),
            persistAllAnnotationNotes: vi.fn(() => deferredNotes.promise),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const firstSave = handleSave();
        const queuedSave = handleSave();
        await Promise.resolve();
        expect(deps.persistAllAnnotationNotes).toHaveBeenCalledOnce();

        deps.originalPath.value = cast('/tmp/replacement.pdf');
        deps.workingCopyPath.value = cast('/tmp/replacement-working.pdf');
        deps.documentRevisionToken.value = requireDocumentRevisionToken('rev-2');
        deferredNotes.resolve(true);

        await expect(firstSave).resolves.toBe(false);
        await expect(queuedSave).resolves.toBe(false);
        expect(deps.persistAllAnnotationNotes).toHaveBeenCalledOnce();
        expect(deps.saveFile).not.toHaveBeenCalled();
    });

    it('surfaces a toast when PDF.js saveDocument returns no data repeatedly', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const livePdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ annotationStorage: {
            resetModified: vi.fn(),
            modifiedIds: { ids: new Set(['3856R']) },
        } }));
        const { deps } = createDeps({
            annotationDirty: ref(true),
            pdfDocument: livePdfDocument,
            saveDocument: vi.fn(async () => null),
        });
        const { handleSave } = useWorkspaceSaveServiceForTest(deps);

        const result = await handleSave();

        expect(result).toBe(false);
        expect(deps.saveDocument).toHaveBeenCalledTimes(4);
        expect(deps.serializePdfForSave).not.toHaveBeenCalled();
        expect(deps.saveFile).not.toHaveBeenCalled();
        expect(deps.isSaving.value).toBe(false);
        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.save',
            description: 'saveDocument returned no data',
        }));
    });
});
