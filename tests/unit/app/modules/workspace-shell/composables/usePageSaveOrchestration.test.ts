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
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { usePageSaveOrchestration } from '@app/modules/workspace-shell/composables/usePageSaveOrchestration';
import type { IScrollSnapshot } from '@app/types/pdfUi';
import type {IWorkspaceSaveDependencies} from '@app/modules/workspace-shell/composables/file-operations/workspaceSaveService';
import { cast } from '@tests/helpers/cast';

const saveMocks = vi.hoisted(() => ({
    capturedDeps: null as unknown,
    handleSave: vi.fn(),
    handleRepairSave: vi.fn(),
    handleOptimizePdfForInteraction: vi.fn(),
    handleOptimizePdfAsCopy: vi.fn(),
    handleSaveAs: vi.fn(),
}));
const platformMocks = vi.hoisted(() => ({statFile: vi.fn()}));

vi.mock(
    '@app/modules/workspace-shell/composables/file-operations/workspaceSaveService',
    () => ({useWorkspaceSaveService: vi.fn((deps: unknown) => {
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
        serializeShapeAnnotations: vi.fn(),
        embedPlacedImageToPage: vi.fn(),
        updateEmbeddedAnnotationByRef: vi.fn(),
        deleteEmbeddedAnnotationByRef: vi.fn(),
        rewritePageLabels: vi.fn(),
    })}),
);

function createDeps(overrides: Record<string, unknown> = {}) {
    return cast<Parameters<typeof usePageSaveOrchestration>[0]>({
        pdfData: ref(new Uint8Array([1])),
        pdfDocument: shallowRef({numPages: 1} as PDFDocumentProxy),
        pdfViewerRef: ref({
            scrollToPage: vi.fn(),
            runSaveTransaction: vi.fn(),
            getAllShapes: vi.fn(() => []),
        }),
        workingCopyPath: ref('/tmp/document.pdf'),
        originalPath: ref('/tmp/source.pdf'),
        documentRevisionToken: ref(null),
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
        validatePdfPath: vi.fn(async () => ({
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
        ...overrides,
    });
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
            pdfDocument: shallowRef({numPages: 50} as PDFDocumentProxy),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                runSaveTransaction: vi.fn(),
                getAllShapes: vi.fn(() => []),
                captureScrollSnapshot: vi.fn(() => scrollSnapshot),
                preserveNextSourceReloadVisibleContent,
            }),
        }));

        const dependencies = cast<IWorkspaceSaveDependencies>(saveMocks.capturedDeps);
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
        const dependencies = cast<IWorkspaceSaveDependencies>(saveMocks.capturedDeps);

        await expect(
            dependencies.persistence.getWorkingCopySize?.('/tmp/document.pdf'),
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
});
