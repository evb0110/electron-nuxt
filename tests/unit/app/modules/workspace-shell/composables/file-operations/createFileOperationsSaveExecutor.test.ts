import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import type {IFileOperationsSaveContext} from '@app/modules/workspace-shell/composables/file-operations/createFileOperationsSaveContext';
import {
    createFileOperationsSaveExecutor,
    type IFileOperationsSaveExecutionConfig,
    type IFileOperationsSaveExecutorPorts,
    type IFileOperationsSaveExecutorServices,
} from '@app/modules/workspace-shell/composables/file-operations/createFileOperationsSaveExecutor';
import type { TWorkspaceSavePersistenceRoute } from '@app/modules/workspace-shell/composables/file-operations/workspaceSavePlan';
import type {
    IPdfViewerAnnotationSavePlan,
    IPdfViewerSaveTransactionResult,
} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';
import { cast } from '@tests/helpers/cast';
import {requireDocumentRevisionToken} from '@contracts';

const cleanAnnotationSavePlan: IPdfViewerAnnotationSavePlan = {
    route: 'source-clean',
    expectedCost: 'small',
    reason: 'no-live-pdfjs-annotation-work',
    unreplayableLiveAnnotationIds: [],
};

function createPersistResult() {
    return {
        success: true,
        outPath: '/tmp/work.pdf',
        saveMode: 'rewrite' as const,
        didSaveAs: false,
    };
}

function createExecutorFixture(overrides: {runSaveTransaction?: () => Promise<Partial<IPdfViewerSaveTransactionResult>>;} = {}) {
    const ports: IFileOperationsSaveExecutorPorts = {
        state: {
            documentIdentity: {
                workingCopyPath: ref('/tmp/work.pdf'),
                originalPath: ref('/tmp/source.pdf'),
                documentRevisionToken: ref(requireDocumentRevisionToken('rev-1')),
            },
            metadata: {
                pageLabelsDirty: ref(false),
                bookmarksDirty: ref(false),
            },
        },
        pdf: {
            source: {
                pdfDocument: shallowRef(null),
                runSaveTransaction: vi.fn(async () => ({
                    source: 'source-clean' as const,
                    baseBytes: new Uint8Array([1]),
                    serializedBytes: null,
                    serializedResult: null,
                    nativeMutationProjection: null,
                    annotationSavePlan: cleanAnnotationSavePlan,
                    ...(overrides.runSaveTransaction ? await overrides.runSaveTransaction() : {}),
                })),
                saveDocument: vi.fn(async () => new Uint8Array([7])),
                getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
            },
            serialization: {serializePdfForSave: vi.fn(async data => new Uint8Array([
                ...data,
                5,
            ]))},
        },
        persistence: {
            file: {
                validatePdfPath: vi.fn(async () => ({
                    isValid: true,
                    tool: 'qpdf' as const,
                    errors: [],
                    warnings: [],
                })),
                saveFile: vi.fn(async () => createPersistResult()),
                saveWorkingCopy: vi.fn(async () => createPersistResult()),
                saveWorkingCopyAs: vi.fn(async () => ({
                    ...createPersistResult(),
                    didSaveAs: true,
                    saveMode: 'save_as_rewrite' as const,
                })),
            },
            nativeWorkingCopy: {},
            nativeMutations: {},
        },
        viewer: {
            markup: {},
            shapes: {},
        },
    };
    const services: IFileOperationsSaveExecutorServices = {
        clearSaveIndicator: vi.fn(),
        completion: {
            armPersistedShapeStateAdoption: vi.fn(() => false),
            finalizeSaveReload: vi.fn(async () => undefined),
            finalizeSuccessfulSave: vi.fn(result => result.success),
            primePersistedShapeStateForSave: vi.fn(async () => null),
            refreshAnnotationSaveStateSnapshot: vi.fn(snapshot => snapshot),
            restorePreparedShapeState: vi.fn(async () => undefined),
        },
        timedSavePhase: vi.fn(async (_phase, operation) => operation()),
        trackSaveCompleted: vi.fn(),
    };

    return {
        executor: createFileOperationsSaveExecutor(ports, services),
        ports,
        services,
    };
}

function createContext(route: TWorkspaceSavePersistenceRoute): IFileOperationsSaveContext {
    const markFinalized = vi.fn();
    return cast<IFileOperationsSaveContext>({
        dirtyState: {
            annotationChanges: false,
            annotationDirty: false,
            bookmarks: false,
            livePdfJsAnnotations: false,
            pageLabels: false,
            pendingDeletes: false,
            pendingTexts: false,
            preservedAnnotationSource: false,
            savedPdfjsAnnotationBaseline: false,
            shapes: false,
        },
        savePlan: {
            flowMode: 'save',
            persistenceRoute: route,
            serialization: {
                shouldSerialize: route !== 'working-copy',
                forcedByDirtyState: route !== 'working-copy',
                requestedByRepairOrOptimization: false,
                forceRewrite: false,
            },
            pdfjsSourceMaterialization: {
                required: false,
                forcePdfjsMaterialize: false,
                includeManagedShapesForLiveSource: false,
            },
            livePdfjsAnnotationSession: {canPreserve: true},
            rendererFullPdfSerialization: {requiresLargeFileGuard: false},
            staleTargetProtection: {
                expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-1'),
                expectedOriginalPath: '/tmp/source.pdf',
                expectedWorkingPath: '/tmp/work.pdf',
            },
        },
        saveStateSnapshot: {
            annotation: 'annotation-token',
            pageLabels: 'page-label-token',
            bookmarks: 'bookmark-token',
        },
        hasPendingDeletes: false,
        hasPendingTexts: false,
        pendingDeletes: null,
        pendingTexts: null,
        reloadWaiter: {
            current: null,
            finalized: false,
            cancel: vi.fn(),
            cancelPending: vi.fn(),
            markFinalized,
        },
        shapeStateDirty: false,
    });
}

function createExecutionConfig(overrides: Partial<IFileOperationsSaveExecutionConfig> = {}): IFileOperationsSaveExecutionConfig {
    return {
        mode: 'save',
        saveMode: 'rewrite',
        persistSerialized: vi.fn(async () => createPersistResult()),
        persistUnserialized: vi.fn(async () => createPersistResult()),
        ...overrides,
    };
}

describe('createFileOperationsSaveExecutor', () => {
    it('executes clean working-copy saves through validation and unserialized persistence', async () => {
        const {
            executor,
            ports,
            services,
        } = createExecutorFixture();
        const config = createExecutionConfig();
        const context = createContext('working-copy');

        await expect(executor.executeSelectedSavePath(config, context)).resolves.toBe(true);

        expect(ports.persistence.file.validatePdfPath).toHaveBeenCalledWith('/tmp/work.pdf');
        expect(config.persistUnserialized).toHaveBeenCalledWith({
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/work.pdf',
            expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-1'),
        });
        expect(ports.pdf.source.runSaveTransaction).not.toHaveBeenCalled();
        expect(ports.pdf.serialization.serializePdfForSave).not.toHaveBeenCalled();
        expect(services.completion.finalizeSuccessfulSave).toHaveBeenCalledWith(
            expect.objectContaining({success: true}),
            expect.objectContaining({resetAnnotationStorage: false}),
        );
        expect(services.trackSaveCompleted).toHaveBeenCalledWith('save', expect.any(Object), false);
        expect(context.reloadWaiter.markFinalized).toHaveBeenCalledOnce();
    });

    it('skips serialized persistence when the working copy changes after source bytes are prepared', async () => {
        const fixture = createExecutorFixture({runSaveTransaction: async () => {
            fixture.ports.state.documentIdentity.workingCopyPath.value = '/tmp/other.pdf';
            return {
                baseBytes: new Uint8Array([1]),
                serializedBytes: null,
            };
        }});
        const config = createExecutionConfig();
        const context = createContext('serialized-rewrite');

        await expect(fixture.executor.executeSelectedSavePath(config, context)).resolves.toBe(false);

        expect(fixture.ports.pdf.source.runSaveTransaction).toHaveBeenCalledOnce();
        expect(config.persistSerialized).not.toHaveBeenCalled();
        expect(fixture.services.completion.finalizeSaveReload).toHaveBeenCalledWith(null, false);
        expect(context.reloadWaiter.markFinalized).toHaveBeenCalledOnce();
    });

    it('persists the serialized transaction result when a rewrite is selected', async () => {
        const verifyAnnotationSave = vi.fn(async () => undefined);
        const verifyAnnotationSavePath = vi.fn(async () => undefined);
        const assertAnnotationSaveCurrent = vi.fn();
        const serializedResult = {
            finalBytes: new Uint8Array([
                8,
                9,
            ]),
            saveMode: 'rewrite' as const,
            source: 'serialized-rewrite' as const,
            changedObjectRefs: ['12 0 R'],
        };
        const fixture = createExecutorFixture({runSaveTransaction: async () => ({
            source: 'serialized-rewrite' as const,
            baseBytes: new Uint8Array([1]),
            serializedBytes: new Uint8Array([2]),
            serializedResult,
            verifyAnnotationSave,
            verifyAnnotationSavePath,
            assertAnnotationSaveCurrent,
        })});
        const persistSerialized = vi.fn(async (
            _data: Uint8Array,
            options: Parameters<IFileOperationsSaveExecutionConfig['persistSerialized']>[1],
        ) => {
            expect(verifyAnnotationSave).not.toHaveBeenCalled();
            await options.commitCallbacks?.verifyPathBeforeCommit?.('/tmp/staged.pdf', 2);
            await options.commitCallbacks?.assertBeforeCommit?.();
            return createPersistResult();
        });
        const config = createExecutionConfig({persistSerialized});
        const context = createContext('serialized-rewrite');

        await expect(fixture.executor.executeSelectedSavePath(config, context)).resolves.toBe(true);

        expect(fixture.ports.pdf.source.runSaveTransaction).toHaveBeenCalledWith(expect.objectContaining({
            source: {
                getSourcePdfData: fixture.ports.pdf.source.getSourcePdfData,
                serializePdfForSave: fixture.ports.pdf.serialization.serializePdfForSave,
            },
            serializeResult: true,
        }));
        expect(config.persistSerialized).toHaveBeenCalledWith(serializedResult.finalBytes, {
            saveMode: 'rewrite',
            preserveLoadedSource: true,
            expectedWorkingPath: '/tmp/work.pdf',
            expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-1'),
            changedObjectRefs: ['12 0 R'],
            commitCallbacks: {
                verifyBytesBeforeCommit: verifyAnnotationSave,
                verifyPathBeforeCommit: verifyAnnotationSavePath,
                assertBeforeCommit: assertAnnotationSaveCurrent,
            },
        });
        expect(verifyAnnotationSavePath).toHaveBeenCalledWith('/tmp/staged.pdf', 2);
        expect(assertAnnotationSaveCurrent).toHaveBeenCalledOnce();
        expect(verifyAnnotationSave).not.toHaveBeenCalled();
        expect(fixture.services.completion.primePersistedShapeStateForSave)
            .toHaveBeenCalledWith(serializedResult.finalBytes, false);
        expect(context.reloadWaiter.markFinalized).toHaveBeenCalledOnce();
    });

    it('threads revision CAS through optimize-as-copy persistence', async () => {
        const fixture = createExecutorFixture();
        const optimizeWorkingCopyAsCopy = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/optimized.pdf',
            saveMode: 'save_as_rewrite' as const,
            didSaveAs: true,
        }));
        const nativeWorkingCopy = fixture.ports.persistence.nativeWorkingCopy;
        if (!nativeWorkingCopy) {
            throw new Error('Expected native working-copy persistence ports');
        }
        nativeWorkingCopy.optimizeWorkingCopyAsCopy = optimizeWorkingCopyAsCopy;

        await expect(fixture.executor.executeOptimizeCopySave({
            expectedWorkingPath: '/tmp/work.pdf',
            expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-1'),
            options: {preset: 'lossless'},
            requestId: 'optimize-1',
            reloadWaiter: null,
        })).resolves.toBe(true);

        expect(optimizeWorkingCopyAsCopy).toHaveBeenCalledWith(
            {preset: 'lossless'},
            'optimize-1',
            {
                saveMode: 'save_as_rewrite',
                expectedWorkingPath: '/tmp/work.pdf',
                expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-1'),
            },
        );
    });
});
