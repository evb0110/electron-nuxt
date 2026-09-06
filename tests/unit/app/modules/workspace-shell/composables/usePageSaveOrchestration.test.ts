import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
    shallowRef,
} from 'vue';
import { usePageSaveOrchestration } from '@app/modules/workspace-shell/composables/usePageSaveOrchestration';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import type { IScrollSnapshot } from '@app/types/pdfUi';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {IWorkspaceSaveDependencies} from '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import { requirePageNumber } from '@contracts/pageNumbers';
import { createPdfDocumentProxy } from '@tests/helpers/createPdfDocumentProxy';
import { TEST_PDF_SAVE_BYTE_ROUTE_DECISION } from '@tests/unit/app/modules/pdf-viewer/runtime/save/testPdfSaveByteRouteDecision';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';

type TPageSaveOrchestrationDeps = Parameters<typeof usePageSaveOrchestration>[0];
type TPageSaveViewer = NonNullable<TPageSaveOrchestrationDeps['pdfViewerRef']['value']>;
type TPageSaveOrchestrationOverrides = Omit<Partial<TPageSaveOrchestrationDeps>, 'hasPendingUnsavedChanges'> & {hasPendingUnsavedChanges?: TPageSaveOrchestrationDeps['hasPendingUnsavedChanges'] | undefined;};
type TCreateTextMarkupOptions = Parameters<IPdfViewerExpose['createTextMarkupFromText']>[0];
type TSaveTransactionResult = Awaited<ReturnType<IPdfViewerExpose['runSaveTransaction']>>;

const saveMocks = vi.hoisted(() => ({
    capturedDeps: null as IWorkspaceSaveDependencies | null,
    handleSave: vi.fn(),
    handleRepairSave: vi.fn(),
    handleOptimizePdfForInteraction: vi.fn(),
    handleOptimizePdfAsCopy: vi.fn(),
    handleSaveAs: vi.fn(),
}));
const platformMocks = vi.hoisted(() => ({statFile: vi.fn()}));

vi.mock(
    '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService',
    () => ({useWorkspaceSaveService: vi.fn((deps: IWorkspaceSaveDependencies) => {
        saveMocks.capturedDeps = deps;
        return {
            handleSave: saveMocks.handleSave,
            handleRepairSave: saveMocks.handleRepairSave,
            handleOptimizePdfForInteraction: saveMocks.handleOptimizePdfForInteraction,
            handleOptimizePdfAsCopy: saveMocks.handleOptimizePdfAsCopy,
            handleSaveAs: saveMocks.handleSaveAs,
        };
    })}),
);
vi.mock('@app/utils/platformDocuments', () => ({getDocumentFilesCapability: () => ({statFile: platformMocks.statFile})}));
vi.mock(
    '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfSerialization',
    () => ({usePdfSerialization: () => ({
        getSourcePdfData: vi.fn(async () => new Uint8Array([1])),
        serializePdfForSave: vi.fn(async (data: Uint8Array) => data),
        rewriteMarkupSubtypes: vi.fn(),
        embedPlacedImageToPage: vi.fn(),
        updateEmbeddedAnnotationByRef: vi.fn(),
        deleteEmbeddedAnnotationByRef: vi.fn(),
        rewritePageLabels: vi.fn(),
    })}),
);

function createPdfViewerFixture(overrides: Partial<TPageSaveViewer> = {}): TPageSaveViewer {
    const viewer: IPdfViewerExpose = {
        getViewerContainer: () => null,
        scrollToPage: vi.fn(),
        captureRegionToClipboard: vi.fn(async () => false),
        isCapturingRegion: false,
        startCropSelection: vi.fn(async () => null),
        cancelCropSelection: vi.fn(),
        isCropSelecting: false,
        runSaveTransaction: vi.fn(async () => ({
            source: 'pdfjs-materialize' as const,
            baseBytes: null,
            serializedBytes: null,
            serializedResult: null,
            nativeMutationProjection: null,
            fallbackDecision: TEST_PDF_SAVE_BYTE_ROUTE_DECISION,
            annotationSavePlan: {
                route: 'source-clean' as const,
                expectedCost: 'small' as const,
                reason: 'no-live-pdfjs-annotation-work' as const,
                unreplayableLiveAnnotationIds: [],
            },
        })),
        saveDocument: vi.fn(async () => null),
        materializePdfJsDocumentForInternalUse: vi.fn(async () => null),
        highlightSelection: vi.fn(async () => false),
        commentSelection: vi.fn(async () => false),
        createTextMarkupFromText: vi.fn(async (options: TCreateTextMarkupOptions) => ({
            created: false,
            pageNumber: options.pageNumber,
            requestedText: options.text,
            matchedText: null,
            occurrence: options.occurrence ?? 1,
            subtype: 'Highlight' as const,
        })),
        commentAtPoint: vi.fn(async () => false),
        createPointNoteAnnotation: vi.fn(async () => ({
            created: false,
            pageNumber: requirePageNumber(1),
            pageX: 0,
            pageY: 0,
        })),
        createShapeAnnotation: vi.fn(async () => ({
            created: false,
            pageNumber: requirePageNumber(1),
            shape: null,
        })),
        startCommentPlacement: vi.fn(),
        cancelCommentPlacement: vi.fn(),
        focusAnnotationComment: vi.fn(async () => {}),
        updateAnnotationComment: vi.fn(() => false),
        deleteAnnotationComment: vi.fn(async () => false),
        moveAnnotationMarker: vi.fn(() => false),
        rerenderAnnotationPage: vi.fn(async () => false),
        removeAnnotationFromDom: vi.fn(),
        removeAnnotationFromInternalCache: vi.fn(),
        getMarkupSubtypeOverrides: () => new Map(),
        getAllShapes: () => [],
        getDeletedEmbeddedShapeAnnotationIds: () => [],
        clearShapes: vi.fn(),
        clearSelectedShape: vi.fn(),
        deleteSelectedShape: vi.fn(),
        hasShapes: false,
        selectedShapeId: null,
        updateShape: vi.fn(),
        getSelectedShape: () => null,
        startImagePlacement: vi.fn(async () => false),
        clearPendingImagePlacement: vi.fn(),
        restorePendingImagePlacement: vi.fn(),
        invalidatePages: vi.fn(),
        requestScrollToCurrentResult: vi.fn(),
    };

    return {
        ...viewer,
        ...overrides,
    };
}

function createSaveTransactionResult(
    overrides: Partial<TSaveTransactionResult> = {},
): TSaveTransactionResult {
    return {
        source: 'serialized-rewrite',
        baseBytes: null,
        serializedBytes: null,
        serializedResult: null,
        nativeMutationProjection: null,
        fallbackDecision: TEST_PDF_SAVE_BYTE_ROUTE_DECISION,
        annotationSavePlan: TEST_PDF_SAVE_BYTE_ROUTE_DECISION.annotationPlan,
        ...overrides,
    };
}

function requireCapturedDependencies(): IWorkspaceSaveDependencies {
    if (!saveMocks.capturedDeps) {
        throw new Error('Expected save service dependencies to be captured');
    }
    return saveMocks.capturedDeps;
}

function createDeps(overrides: TPageSaveOrchestrationOverrides = {}): TPageSaveOrchestrationDeps {
    const {
        hasPendingUnsavedChanges: pendingOverride,
        ...otherOverrides
    } = overrides;
    const omitPending = Object.hasOwn(overrides, 'hasPendingUnsavedChanges')
        && pendingOverride === undefined;
    const defaults = {
        pdfData: ref(new Uint8Array([1])),
        pdfDocument: shallowRef(createPdfDocumentProxy({numPages: 1})),
        pdfViewerRef: ref<TPageSaveViewer | null>(createPdfViewerFixture()),
        workingCopyPath: ref<TDocumentRef | null>(requireDocumentRef('/tmp/document.pdf')),
        originalPath: ref<TDocumentRef | null>(requireDocumentRef('/tmp/source.pdf')),
        documentSessionKey: ref('document-session-1'),
        documentRevisionToken: ref<TDocumentRevisionToken | null>(null),
        totalPages: ref(1),
        pageLabelsDirty: ref(false),
        pageLabelRanges: ref([]),
        bookmarksDirty: ref(false),
        bookmarkItems: ref([]),
        isSaving: ref(false),
        isSavingAs: ref(false),
        annotationDirty: ref(false),
        annotationNoteWindowsCount: ref(0),
        pendingEmbeddedAnnotationDeleteCount: ref(0),
        hasAnnotationChanges: vi.fn(() => false),
        markAnnotationSaved: vi.fn(),
        markPageLabelsSaved: vi.fn(),
        markBookmarksSaved: vi.fn(),
        isDirty: ref(false),
        hasPendingUnsavedChanges: computed(() => false),
        validatePdfPath: vi.fn< IWorkspaceSaveDependencies['persistence']['validatePdfPath']>(async () => ({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        })),
        saveFile: vi.fn(),
        saveWorkingCopy: vi.fn(),
        saveWorkingCopyAs: vi.fn(),
        persistAllAnnotationNotes: vi.fn(async () => true),
        loadRecentFiles: vi.fn(),
        currentPage: ref(1),
        resetSearchCache: vi.fn(),
    } satisfies TPageSaveOrchestrationDeps;

    if (omitPending) {
        const {
            hasPendingUnsavedChanges: _defaultPending,
            ...defaultsWithoutPending
        } = defaults;
        return {
            ...defaultsWithoutPending,
            ...otherOverrides,
        };
    }

    return {
        ...defaults,
        ...otherOverrides,
        hasPendingUnsavedChanges: pendingOverride ?? defaults.hasPendingUnsavedChanges,
    };
}

describe('usePageSaveOrchestration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        saveMocks.capturedDeps = null;
        platformMocks.statFile.mockResolvedValue({size: 1});
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
    });

    it('arms preserved PDF and metadata reloads without rewriting the current page', () => {
        const currentPage = ref(41);
        const scrollSnapshot: IScrollSnapshot = {
            width: 800,
            height: 4000,
            centerX: 300,
            centerY: 2100,
            anchorPage: 42,
            anchorInsidePage: true,
            anchorOffsetRatio: 0.25,
            anchorContentXRatio: 0.375,
            anchorContentYRatio: 0.525,
            anchorPageXRatio: 0.5,
            anchorPageYRatio: 0.25,
            anchorPageYOutsideEdge: 'inside',
            anchorPageYOutsideOffsetPx: null,
        };
        const preserveNextSourceReloadVisibleContent = vi.fn();
        const preserveMetadataForNextSourceReload = vi.fn();
        const clearPreservedSourceReloadMetadata = vi.fn();

        usePageSaveOrchestration(createDeps({
            currentPage,
            totalPages: ref(50),
            bookmarksDirty: ref(true),
            preserveMetadataForNextSourceReload,
            clearPreservedSourceReloadMetadata,
            pdfDocument: shallowRef(createPdfDocumentProxy({numPages: 50})),
            pdfViewerRef: ref(createPdfViewerFixture({
                scrollToPage: vi.fn(),
                runSaveTransaction: vi.fn(),
                getAllShapes: vi.fn(() => []),
                captureScrollSnapshot: vi.fn(() => scrollSnapshot),
                preserveNextSourceReloadVisibleContent,
            })),
        }));

        const dependencies = requireCapturedDependencies();
        const reloadWaiter = dependencies.lifecycle.preparePostSaveReload?.();
        expect(reloadWaiter).toBeDefined();
        reloadWaiter?.cancel();

        expect(currentPage.value).toBe(41);
        expect(preserveMetadataForNextSourceReload).toHaveBeenCalledOnce();
        expect(clearPreservedSourceReloadMetadata).toHaveBeenCalledOnce();
        expect(preserveNextSourceReloadVisibleContent).toHaveBeenCalledWith({
            scrollSnapshot,
            pageToRestore: 42,
        });
    });

    it('gets the working-copy size through the split file capability', async () => {
        usePageSaveOrchestration(createDeps());
        const dependencies = requireCapturedDependencies();

        await expect(
            dependencies.persistence.getWorkingCopySize?.(requireDocumentRef('/tmp/document.pdf')),
        ).resolves.toBe(1);
        expect(platformMocks.statFile).toHaveBeenCalledWith('/tmp/document.pdf');
    });

    it('uses live annotation predicates in the canSave fallback', () => {
        const orchestration = usePageSaveOrchestration(createDeps({
            hasPendingUnsavedChanges: undefined,
            hasLivePdfJsAnnotationChanges: vi.fn(() => true),
        }));

        expect(orchestration.canSave.value).toBe(true);
    });

    it('treats an already clean save command as a successful no-op', async () => {
        const orchestration = usePageSaveOrchestration(createDeps());

        await expect(orchestration.handleSave()).resolves.toBe(true);
        expect(saveMocks.handleSave).not.toHaveBeenCalled();
    });

    it('reconciles a preserved source signal only when a save command runs', async () => {
        const preservedSourceDirty = ref(true);
        const reconcilePreservedAnnotationSourceDirty = vi.fn(() => {
            preservedSourceDirty.value = false;
        });
        const orchestration = usePageSaveOrchestration(createDeps({
            hasPendingUnsavedChanges: undefined,
            hasPreservedAnnotationSourceChanges: () => preservedSourceDirty.value,
            reconcilePreservedAnnotationSourceDirty,
        }));

        expect(orchestration.canSave.value).toBe(true);
        expect(reconcilePreservedAnnotationSourceDirty).not.toHaveBeenCalled();
        await expect(orchestration.handleSave()).resolves.toBe(true);
        expect(reconcilePreservedAnnotationSourceDirty).toHaveBeenCalledOnce();
        expect(orchestration.canSave.value).toBe(false);
        expect(saveMocks.handleSave).not.toHaveBeenCalled();
    });

    it('exposes the viewer editor commit before workspace save planning', async () => {
        const commitPdfEditorsForSave = vi.fn(async () => undefined);
        usePageSaveOrchestration(createDeps({pdfViewerRef: ref(createPdfViewerFixture({
            commitPdfEditorsForSave,
            getAllShapes: vi.fn(() => []),
            runSaveTransaction: vi.fn(),
        }))}));
        const dependencies = requireCapturedDependencies();

        await dependencies.pdf.commitEditorsForSave?.();

        expect(commitPdfEditorsForSave).toHaveBeenCalledOnce();
    });

    it('saves dirty changes before optimizing the PDF for interaction', async () => {
        saveMocks.handleSave.mockResolvedValueOnce(true);
        saveMocks.handleOptimizePdfForInteraction.mockResolvedValueOnce(true);
        const orchestration = usePageSaveOrchestration(createDeps({
            isDirty: ref(true),
            hasPendingUnsavedChanges: computed(() => true),
        }));

        await expect(
            orchestration.handleOptimizePdfForInteraction(),
        ).resolves.toBe(true);
        expect(saveMocks.handleSave).toHaveBeenCalledOnce();
        expect(saveMocks.handleOptimizePdfForInteraction).toHaveBeenCalledOnce();
        expect(saveMocks.handleSave.mock.invocationCallOrder[0]!)
            .toBeLessThan(
                saveMocks.handleOptimizePdfForInteraction.mock.invocationCallOrder[0]!,
            );
    });

    it('creates a detached recovery snapshot without acknowledging the dirty save frontier', async () => {
        const assertAnnotationSaveCurrent = vi.fn(async () => undefined);
        const verifyAnnotationSave = vi.fn(async () => undefined);
        const commitAnnotationSave = vi.fn();
        const runSaveTransaction = vi.fn(async () => createSaveTransactionResult({
            serializedBytes: Uint8Array.of(4, 5, 6),
            assertAnnotationSaveCurrent,
            verifyAnnotationSave,
            commitAnnotationSave,
        }));
        const runWithDocumentOperationLeaseSpy = vi.fn();
        const runWithDocumentOperationLease = async <T>(
            _kind: TDocumentOperationKind,
            operation: () => Promise<T>,
        ): Promise<T> => {
            runWithDocumentOperationLeaseSpy(_kind, operation);
            return operation();
        };
        const orchestration = usePageSaveOrchestration(createDeps({
            annotationDirty: ref(true),
            hasPendingUnsavedChanges: computed(() => true),
            workingCopyPath: ref<TDocumentRef | null>(requireDocumentRef('browser://documents/recovery.pdf')),
            pdfViewerRef: ref(createPdfViewerFixture({
                runSaveTransaction,
                getAllShapes: vi.fn(() => []),
            })),
            runWithDocumentOperationLease,
        }));

        await expect(orchestration.createRecoverySnapshotBytes()).resolves.toEqual(Uint8Array.of(4, 5, 6));

        expect(runWithDocumentOperationLeaseSpy).toHaveBeenCalledWith('recovery-snapshot', expect.any(Function));
        expect(runSaveTransaction).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'snapshot',
            saveFlowMode: 'save',
            serializeResult: true,
        }));
        expect(assertAnnotationSaveCurrent).toHaveBeenCalledOnce();
        expect(verifyAnnotationSave).toHaveBeenCalledWith(Uint8Array.of(4, 5, 6));
        expect(commitAnnotationSave).not.toHaveBeenCalled();
    });

    it('does not serialize a recovery snapshot for a clean document', async () => {
        const runSaveTransaction = vi.fn();
        const orchestration = usePageSaveOrchestration(createDeps({pdfViewerRef: ref(createPdfViewerFixture({
            runSaveTransaction,
            getAllShapes: vi.fn(() => []),
        }))}));

        await expect(orchestration.createRecoverySnapshotBytes()).resolves.toBeNull();
        expect(runSaveTransaction).not.toHaveBeenCalled();
    });

    it('discards a recovery snapshot when the document revision changes during serialization', async () => {
        const documentRevisionToken = ref<TDocumentRevisionToken | null>(
            requireDocumentRevisionToken('revision-1'),
        );
        const runSaveTransaction = vi.fn(async () => {
            documentRevisionToken.value = requireDocumentRevisionToken('revision-2');
            return createSaveTransactionResult({serializedBytes: Uint8Array.of(4, 5, 6)});
        });
        const orchestration = usePageSaveOrchestration(createDeps({
            annotationDirty: ref(true),
            documentRevisionToken,
            hasPendingUnsavedChanges: computed(() => true),
            pdfViewerRef: ref(createPdfViewerFixture({
                runSaveTransaction,
                getAllShapes: vi.fn(() => []),
            })),
        }));

        await expect(orchestration.createRecoverySnapshotBytes()).resolves.toBeNull();
    });
});
