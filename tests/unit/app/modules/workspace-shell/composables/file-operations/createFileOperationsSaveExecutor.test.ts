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
import { cast } from '@tests/helpers/cast';

function createPersistResult() {
    return {
        success: true,
        outPath: '/tmp/work.pdf',
        saveMode: 'rewrite' as const,
        didSaveAs: false,
    };
}

function createExecutorFixture(overrides: {getSerializationBasePdfBytes?: () => Promise<Uint8Array | null>;} = {}) {
    const ports: IFileOperationsSaveExecutorPorts = {
        state: {
            documentIdentity: {
                workingCopyPath: ref('/tmp/work.pdf'),
                originalPath: ref('/tmp/source.pdf'),
            },
            metadata: {
                pageLabelsDirty: ref(false),
                bookmarksDirty: ref(false),
            },
        },
        pdf: {source: {
            pdfDocument: shallowRef(null),
            saveDocument: vi.fn(async () => new Uint8Array([7])),
            getSourcePdfData: vi.fn(async () => new Uint8Array([9])),
        }},
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
        source: {
            buildAnnotationSavePlan: vi.fn(() => ({
                route: 'source-clean',
                reason: 'test',
            })),
            buildSerializedSaveResult: vi.fn(async (rawData, _pendingTexts, _pendingDeletes, opts) => ({
                finalBytes: new Uint8Array([
                    ...rawData,
                    5,
                ]),
                saveMode: opts?.saveMode ?? 'rewrite',
            })),
            getSerializationBasePdfBytes: vi.fn(overrides.getSerializationBasePdfBytes ?? (async () => new Uint8Array([1]))),
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
        annotationCommentsSnapshot: [],
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
        });
        expect(services.source.getSerializationBasePdfBytes).not.toHaveBeenCalled();
        expect(services.completion.finalizeSuccessfulSave).toHaveBeenCalledWith(
            expect.objectContaining({success: true}),
            expect.objectContaining({resetAnnotationStorage: false}),
        );
        expect(services.trackSaveCompleted).toHaveBeenCalledWith('save', expect.any(Object), false);
        expect(context.reloadWaiter.markFinalized).toHaveBeenCalledOnce();
    });

    it('skips serialized persistence when the working copy changes after source bytes are prepared', async () => {
        const fixture = createExecutorFixture({getSerializationBasePdfBytes: async () => {
            fixture.ports.state.documentIdentity.workingCopyPath.value = '/tmp/other.pdf';
            return new Uint8Array([1]);
        }});
        const config = createExecutionConfig();
        const context = createContext('serialized-rewrite');

        await expect(fixture.executor.executeSelectedSavePath(config, context)).resolves.toBe(false);

        expect(fixture.services.source.getSerializationBasePdfBytes).toHaveBeenCalledOnce();
        expect(fixture.services.source.buildSerializedSaveResult).not.toHaveBeenCalled();
        expect(config.persistSerialized).not.toHaveBeenCalled();
        expect(fixture.services.completion.finalizeSaveReload).toHaveBeenCalledWith(null, false);
        expect(context.reloadWaiter.markFinalized).toHaveBeenCalledOnce();
    });
});
