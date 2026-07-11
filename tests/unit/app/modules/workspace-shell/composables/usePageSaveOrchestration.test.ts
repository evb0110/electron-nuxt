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
import type { IFileOperationsSaveAdapterPorts } from '@app/modules/workspace-shell/composables/file-operations/saveRolePorts';
import { createStaleRevisionError } from '@contracts/documentMutationErrors';
import { cast } from '@tests/helpers/cast';
import {requireDocumentRevisionToken} from '@contracts';

const fileOperationMocks = vi.hoisted((): {
    capturedDeps: unknown;
    handleSave: ReturnType<typeof vi.fn>;
    handleRepairSave: ReturnType<typeof vi.fn>;
    handleOptimizePdfForInteraction: ReturnType<typeof vi.fn>;
    handleSaveAs: ReturnType<typeof vi.fn>;
} => ({
    capturedDeps: null,
    handleSave: vi.fn(),
    handleRepairSave: vi.fn(),
    handleOptimizePdfForInteraction: vi.fn(),
    handleSaveAs: vi.fn(),
}));
const platformMocks = vi.hoisted(() => ({
    replaceWorkingCopyFromPath: vi.fn(),
    cleanupOcrTemp: vi.fn(),
    statFile: vi.fn(),
    legacyReplaceWorkingCopyFromPath: vi.fn(),
    legacyStatFile: vi.fn(),
    acknowledgeResultFile: vi.fn(),
    warmIndex: vi.fn(),
    toastAdd: vi.fn(),
}));

vi.mock('@app/modules/workspace-shell/composables/file-operations/useFileOperationsSaveController', () => ({useFileOperationsSaveController: vi.fn((deps: unknown) => {
    fileOperationMocks.capturedDeps = deps;
    return {
        handleSave: fileOperationMocks.handleSave,
        handleRepairSave: fileOperationMocks.handleRepairSave,
        handleOptimizePdfForInteraction: fileOperationMocks.handleOptimizePdfForInteraction,
        handleSaveAs: fileOperationMocks.handleSaveAs,
    };
})}));
vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentFilesCapability: () => ({
        replaceWorkingCopyFromPath: platformMocks.replaceWorkingCopyFromPath,
        statFile: platformMocks.statFile,
    }),
    getDocumentsCapability: () => ({
        replaceWorkingCopyFromPath: platformMocks.legacyReplaceWorkingCopyFromPath,
        cleanupOcrTemp: platformMocks.cleanupOcrTemp,
        statFile: platformMocks.legacyStatFile,
    }),
}));
vi.mock('@app/utils/getOcrCapability', () => ({getOcrCapability: () => ({acknowledgeResultFile: platformMocks.acknowledgeResultFile})}));
vi.mock('@app/utils/getSearchCapability', () => ({getSearchCapability: () => ({warmIndex: platformMocks.warmIndex})}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/usePdfSerialization', () => ({usePdfSerialization: () => ({
    getSourcePdfData: vi.fn(async () => new Uint8Array([1])),
    serializePdfForSave: vi.fn(async (data: Uint8Array) => data),
    rewriteMarkupSubtypes: vi.fn(),
    serializeShapeAnnotations: vi.fn(),
    embedPlacedImageToPage: vi.fn(),
    updateEmbeddedAnnotationByRef: vi.fn(),
    deleteEmbeddedAnnotationByRef: vi.fn(),
    rewritePageLabels: vi.fn(),
})}));

describe('usePageSaveOrchestration', () => {
    beforeEach(() => {
        fileOperationMocks.capturedDeps = null;
        vi.clearAllMocks();
        platformMocks.replaceWorkingCopyFromPath.mockResolvedValue(true);
        platformMocks.cleanupOcrTemp.mockResolvedValue(undefined);
        platformMocks.statFile.mockResolvedValue({size: 1});
        platformMocks.legacyReplaceWorkingCopyFromPath.mockRejectedValue(
            new Error('legacy documents facade replaceWorkingCopyFromPath used'),
        );
        platformMocks.legacyStatFile.mockRejectedValue(
            new Error('legacy documents facade statFile used'),
        );
        platformMocks.acknowledgeResultFile.mockResolvedValue({ cleaned: true });
        platformMocks.warmIndex.mockResolvedValue(undefined);
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
        vi.stubGlobal('useToast', () => ({ add: platformMocks.toastAdd }));
    });

    it('arms preserved PDF and metadata reloads without rewriting the workspace current page', () => {
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
        const pdfViewerRef = ref({
            scrollToPage: vi.fn(),
            captureScrollSnapshot: vi.fn(() => scrollSnapshot),
            restoreScrollSnapshot: vi.fn(),
            preserveNextSourceReloadVisibleContent,
            saveDocument: vi.fn(async () => new Uint8Array([1])),
            getMarkupSubtypeOverrides: vi.fn(() => undefined),
            getAllShapes: vi.fn(() => []),
            getDeletedEmbeddedShapeAnnotationIds: vi.fn(() => []),
        });

        usePageSaveOrchestration(cast({
            pdfData: ref(new Uint8Array([1])),
            pdfDocument: shallowRef({ numPages: 50 } as PDFDocumentProxy),
            pdfViewerRef,
            requestDocxExport: vi.fn(async () => true),
            openOcrPopup: vi.fn(),
            isExportingDocx: ref(false),
            workingCopyPath: ref('/tmp/document.pdf'),
            documentRevisionToken: ref(null),
            annotationComments: ref([]),
            totalPages: ref(50),
            pageLabelsDirty: ref(false),
            pageLabelRanges: ref([]),
            bookmarksDirty: ref(true),
            bookmarkItems: ref([]),
            isSaving: ref(false),
            isSavingAs: ref(false),
            annotationDirty: ref(false),
            annotationNoteWindowsCount: ref(0),
            hasAnnotationChanges: vi.fn(() => false),
            markAnnotationSaved: vi.fn(),
            markPageLabelsSaved: vi.fn(),
            markBookmarksSaved: vi.fn(),
            preserveMetadataForNextSourceReload,
            clearPreservedSourceReloadMetadata,
            isDirty: ref(false),
            hasPendingUnsavedChanges: computed(() => false),
            persistAllAnnotationNotes: vi.fn(async () => true),
            consumePendingEmbeddedTextUpdates: vi.fn(() => null),
            consumePendingEmbeddedAnnotationDeletes: vi.fn(() => null),
            loadRecentFiles: vi.fn(),
            clearOcrCache: vi.fn(),
            loadPdfFromData: vi.fn(async () => {}),
            currentPage,
            waitForPdfReload: vi.fn(async () => {}),
            resetSearchCache: vi.fn(),
            validatePdfPath: vi.fn(async () => ({
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: [],
            })),
            saveFile: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopy: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopyAs: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document-copy.pdf',
                saveMode: 'save_as_rewrite',
                didSaveAs: true,
            })),
        }));

        const capturedPorts = cast<IFileOperationsSaveAdapterPorts>(
            fileOperationMocks.capturedDeps,
        );
        const preparePostSaveReload = capturedPorts.lifecycle.preparePostSaveReload;
        expect(preparePostSaveReload).toBeDefined();
        const reloadWaiter = preparePostSaveReload!();
        reloadWaiter.cancel();

        expect(currentPage.value).toBe(41);
        expect(preserveMetadataForNextSourceReload).toHaveBeenCalledOnce();
        expect(clearPreservedSourceReloadMetadata).toHaveBeenCalledOnce();
        expect(preserveNextSourceReloadVisibleContent).toHaveBeenCalledWith({
            scrollSnapshot,
            pageToRestore: 42,
        });
    });

    it('gets the working-copy size through the split file capability', async () => {
        usePageSaveOrchestration(cast({
            pdfData: ref(new Uint8Array([1])),
            pdfDocument: shallowRef({ numPages: 1 } as PDFDocumentProxy),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                saveDocument: vi.fn(async () => new Uint8Array([1])),
                getMarkupSubtypeOverrides: vi.fn(() => undefined),
                getAllShapes: vi.fn(() => []),
                getDeletedEmbeddedShapeAnnotationIds: vi.fn(() => []),
            }),
            requestDocxExport: vi.fn(async () => true),
            openOcrPopup: vi.fn(),
            isExportingDocx: ref(false),
            workingCopyPath: ref('/tmp/document.pdf'),
            documentRevisionToken: ref(null),
            annotationComments: ref([]),
            totalPages: ref(1),
            pageLabelsDirty: ref(false),
            pageLabelRanges: ref([]),
            bookmarksDirty: ref(false),
            bookmarkItems: ref([]),
            isSaving: ref(false),
            isSavingAs: ref(false),
            annotationDirty: ref(false),
            annotationNoteWindowsCount: ref(0),
            hasAnnotationChanges: vi.fn(() => false),
            markAnnotationSaved: vi.fn(),
            markPageLabelsSaved: vi.fn(),
            markBookmarksSaved: vi.fn(),
            isDirty: ref(false),
            hasPendingUnsavedChanges: computed(() => false),
            persistAllAnnotationNotes: vi.fn(async () => true),
            consumePendingEmbeddedTextUpdates: vi.fn(() => null),
            consumePendingEmbeddedAnnotationDeletes: vi.fn(() => null),
            loadRecentFiles: vi.fn(),
            clearOcrCache: vi.fn(),
            ensureHistoryBaselineForExternalMutation: vi.fn(async () => true),
            reloadWorkingCopyIntoHistory: vi.fn(async () => true),
            currentPage: ref(1),
            waitForPdfReload: vi.fn(async () => {}),
            resetSearchCache: vi.fn(),
            validatePdfPath: vi.fn(async () => ({
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: [],
            })),
            saveFile: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopy: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopyAs: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document-copy.pdf',
                saveMode: 'save_as_rewrite',
                didSaveAs: true,
            })),
        }));

        const capturedPorts = cast<IFileOperationsSaveAdapterPorts>(
            fileOperationMocks.capturedDeps,
        );
        const getWorkingCopySize = capturedPorts.persistence.nativeWorkingCopy?.getWorkingCopySize;
        expect(getWorkingCopySize).toBeDefined();

        await expect(getWorkingCopySize!('/tmp/document.pdf')).resolves.toBe(1);
        expect(platformMocks.statFile).toHaveBeenCalledWith('/tmp/document.pdf');
        expect(platformMocks.legacyStatFile).not.toHaveBeenCalled();
    });

    it('uses live annotation predicates in the canSave fallback', () => {
        const orchestration = usePageSaveOrchestration(cast({
            pdfData: ref(null),
            pdfDocument: shallowRef({ numPages: 1 } as PDFDocumentProxy),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                saveDocument: vi.fn(async () => new Uint8Array([1])),
                getMarkupSubtypeOverrides: vi.fn(() => undefined),
                getAllShapes: vi.fn(() => []),
                getDeletedEmbeddedShapeAnnotationIds: vi.fn(() => []),
            }),
            requestDocxExport: vi.fn(async () => true),
            openOcrPopup: vi.fn(),
            isExportingDocx: ref(false),
            workingCopyPath: ref('/tmp/document.pdf'),
            documentRevisionToken: ref(null),
            annotationComments: ref([]),
            totalPages: ref(1),
            pageLabelsDirty: ref(false),
            pageLabelRanges: ref([]),
            bookmarksDirty: ref(false),
            bookmarkItems: ref([]),
            isSaving: ref(false),
            isSavingAs: ref(false),
            annotationDirty: ref(false),
            annotationNoteWindowsCount: ref(0),
            hasAnnotationChanges: vi.fn(() => false),
            hasLivePdfJsAnnotationChanges: vi.fn(() => true),
            markAnnotationSaved: vi.fn(),
            markPageLabelsSaved: vi.fn(),
            markBookmarksSaved: vi.fn(),
            isDirty: ref(false),
            persistAllAnnotationNotes: vi.fn(async () => true),
            consumePendingEmbeddedTextUpdates: vi.fn(() => null),
            consumePendingEmbeddedAnnotationDeletes: vi.fn(() => null),
            loadRecentFiles: vi.fn(),
            clearOcrCache: vi.fn(),
            ensureHistoryBaselineForExternalMutation: vi.fn(async () => true),
            reloadWorkingCopyIntoHistory: vi.fn(async () => true),
            currentPage: ref(1),
            waitForPdfReload: vi.fn(async () => {}),
            resetSearchCache: vi.fn(),
            validatePdfPath: vi.fn(async () => ({
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: [],
            })),
            saveFile: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopy: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopyAs: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document-copy.pdf',
                saveMode: 'save_as_rewrite',
                didSaveAs: true,
            })),
        }));

        expect(orchestration.canSave.value).toBe(true);
    });

    it('saves dirty changes before optimizing the PDF for interaction', async () => {
        fileOperationMocks.handleSave.mockResolvedValueOnce(true);
        fileOperationMocks.handleOptimizePdfForInteraction.mockResolvedValueOnce(true);
        const orchestration = usePageSaveOrchestration(cast({
            pdfData: ref(null),
            pdfDocument: shallowRef({ numPages: 1 } as PDFDocumentProxy),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                saveDocument: vi.fn(async () => new Uint8Array([1])),
                getMarkupSubtypeOverrides: vi.fn(() => undefined),
                getAllShapes: vi.fn(() => []),
                getDeletedEmbeddedShapeAnnotationIds: vi.fn(() => []),
            }),
            requestDocxExport: vi.fn(async () => true),
            openOcrPopup: vi.fn(),
            isExportingDocx: ref(false),
            workingCopyPath: ref('/tmp/document.pdf'),
            documentRevisionToken: ref(null),
            annotationComments: ref([]),
            totalPages: ref(1),
            pageLabelsDirty: ref(false),
            pageLabelRanges: ref([]),
            bookmarksDirty: ref(false),
            bookmarkItems: ref([]),
            isSaving: ref(false),
            isSavingAs: ref(false),
            annotationDirty: ref(false),
            annotationNoteWindowsCount: ref(0),
            hasAnnotationChanges: vi.fn(() => false),
            markAnnotationSaved: vi.fn(),
            markPageLabelsSaved: vi.fn(),
            markBookmarksSaved: vi.fn(),
            isDirty: ref(true),
            hasPendingUnsavedChanges: computed(() => true),
            persistAllAnnotationNotes: vi.fn(async () => true),
            consumePendingEmbeddedTextUpdates: vi.fn(() => null),
            consumePendingEmbeddedAnnotationDeletes: vi.fn(() => null),
            loadRecentFiles: vi.fn(),
            clearOcrCache: vi.fn(),
            ensureHistoryBaselineForExternalMutation: vi.fn(async () => true),
            reloadWorkingCopyIntoHistory: vi.fn(async () => true),
            currentPage: ref(1),
            waitForPdfReload: vi.fn(async () => {}),
            resetSearchCache: vi.fn(),
            validatePdfPath: vi.fn(async () => ({
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: [],
            })),
            saveFile: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopy: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopyAs: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document-copy.pdf',
                saveMode: 'save_as_rewrite',
                didSaveAs: true,
            })),
        }));

        await expect(orchestration.handleOptimizePdfForInteraction()).resolves.toBe(true);

        expect(fileOperationMocks.handleSave).toHaveBeenCalledOnce();
        expect(fileOperationMocks.handleOptimizePdfForInteraction).toHaveBeenCalledOnce();
        expect(fileOperationMocks.handleSave.mock.invocationCallOrder[0]!)
            .toBeLessThan(fileOperationMocks.handleOptimizePdfForInteraction.mock.invocationCallOrder[0]!);
    });

    it('applies OCR results by replacing the working copy from the temp PDF path', async () => {
        const clearOcrCache = vi.fn();
        const resetSearchCache = vi.fn();
        const ensureHistoryBaselineForExternalMutation = vi.fn(async () => true);
        const reloadWorkingCopyIntoHistory = vi.fn(async () => true);
        const waitForPdfReload = vi.fn(async () => {});
        const runWithDocumentOperationLease = vi.fn(async (_kind: string, operation: () => Promise<unknown>) => operation());
        const orchestration = usePageSaveOrchestration(cast({
            pdfData: ref(null),
            pdfDocument: shallowRef({ numPages: 12 } as PDFDocumentProxy),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                saveDocument: vi.fn(async () => new Uint8Array([1])),
                getMarkupSubtypeOverrides: vi.fn(() => undefined),
                getAllShapes: vi.fn(() => []),
                getDeletedEmbeddedShapeAnnotationIds: vi.fn(() => []),
            }),
            requestDocxExport: vi.fn(async () => true),
            openOcrPopup: vi.fn(),
            isExportingDocx: ref(false),
            workingCopyPath: ref('/tmp/work.pdf'),
            documentRevisionToken: ref('revision-token'),
            annotationComments: ref([]),
            totalPages: ref(12),
            pageLabelsDirty: ref(false),
            pageLabelRanges: ref([]),
            bookmarksDirty: ref(false),
            bookmarkItems: ref([]),
            isSaving: ref(false),
            isSavingAs: ref(false),
            annotationDirty: ref(false),
            annotationNoteWindowsCount: ref(0),
            hasAnnotationChanges: vi.fn(() => false),
            markAnnotationSaved: vi.fn(),
            markPageLabelsSaved: vi.fn(),
            markBookmarksSaved: vi.fn(),
            isDirty: ref(false),
            hasPendingUnsavedChanges: computed(() => false),
            persistAllAnnotationNotes: vi.fn(async () => true),
            consumePendingEmbeddedTextUpdates: vi.fn(() => null),
            consumePendingEmbeddedAnnotationDeletes: vi.fn(() => null),
            loadRecentFiles: vi.fn(),
            clearOcrCache,
            ensureHistoryBaselineForExternalMutation,
            reloadWorkingCopyIntoHistory,
            currentPage: ref(7),
            waitForPdfReload,
            resetSearchCache,
            runWithDocumentOperationLease,
            validatePdfPath: vi.fn(async () => ({
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: [],
            })),
            saveFile: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopy: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopyAs: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document-copy.pdf',
                saveMode: 'save_as_rewrite',
                didSaveAs: true,
            })),
        }));

        await orchestration.handleOcrComplete({
            requestId: 'ocr-1',
            pdfPath: '/tmp/ocr-1-merged.pdf',
            sourceDocumentRevisionToken: requireDocumentRevisionToken('source-revision-token'),
            requiresCleanupAck: true,
            sourceWorkingCopyPath: '/tmp/work.pdf',
        });

        expect(runWithDocumentOperationLease).toHaveBeenCalledWith('ocr-apply', expect.any(Function));
        expect(clearOcrCache).toHaveBeenCalledWith('/tmp/work.pdf');
        expect(resetSearchCache).toHaveBeenCalledTimes(1);
        expect(ensureHistoryBaselineForExternalMutation).toHaveBeenCalledTimes(1);
        expect(
            ensureHistoryBaselineForExternalMutation.mock.invocationCallOrder[0],
        ).toBeLessThan(
            platformMocks.replaceWorkingCopyFromPath.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(waitForPdfReload).toHaveBeenCalledWith(7);
        expect(platformMocks.replaceWorkingCopyFromPath).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            '/tmp/ocr-1-merged.pdf',
            {expectedDocumentRevisionToken: requireDocumentRevisionToken('source-revision-token')},
        );
        expect(reloadWorkingCopyIntoHistory).toHaveBeenCalledWith({ markDirty: true });
        expect(platformMocks.acknowledgeResultFile).toHaveBeenCalledWith(
            'ocr-1',
            '/tmp/ocr-1-merged.pdf',
        );
        expect(platformMocks.cleanupOcrTemp).not.toHaveBeenCalled();
        expect(platformMocks.warmIndex).toHaveBeenCalledWith('/tmp/work.pdf', { pageCount: 12 });
    });

    it('releases the OCR apply document lease before waiting for the viewer reload to settle', async () => {
        const clearOcrCache = vi.fn();
        const resetSearchCache = vi.fn();
        const ensureHistoryBaselineForExternalMutation = vi.fn(async () => true);
        const reloadWorkingCopyIntoHistory = vi.fn(async () => true);
        let resolveReload!: () => void;
        const waitForPdfReload = vi.fn(() => new Promise<void>((resolve) => {
            resolveReload = resolve;
        }));
        let leaseFinished = false;
        const runWithDocumentOperationLease = vi.fn(async (_kind: string, operation: () => Promise<unknown>) => {
            const result = await operation();
            leaseFinished = true;
            return result;
        });
        const orchestration = usePageSaveOrchestration(cast({
            pdfData: ref(null),
            pdfDocument: shallowRef({ numPages: 12 } as PDFDocumentProxy),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                saveDocument: vi.fn(async () => new Uint8Array([1])),
                getMarkupSubtypeOverrides: vi.fn(() => undefined),
                getAllShapes: vi.fn(() => []),
                getDeletedEmbeddedShapeAnnotationIds: vi.fn(() => []),
            }),
            requestDocxExport: vi.fn(async () => true),
            openOcrPopup: vi.fn(),
            isExportingDocx: ref(false),
            workingCopyPath: ref('/tmp/work.pdf'),
            documentRevisionToken: ref('revision-token'),
            annotationComments: ref([]),
            totalPages: ref(12),
            pageLabelsDirty: ref(false),
            pageLabelRanges: ref([]),
            bookmarksDirty: ref(false),
            bookmarkItems: ref([]),
            isSaving: ref(false),
            isSavingAs: ref(false),
            annotationDirty: ref(false),
            annotationNoteWindowsCount: ref(0),
            hasAnnotationChanges: vi.fn(() => false),
            markAnnotationSaved: vi.fn(),
            markPageLabelsSaved: vi.fn(),
            markBookmarksSaved: vi.fn(),
            isDirty: ref(false),
            hasPendingUnsavedChanges: computed(() => false),
            persistAllAnnotationNotes: vi.fn(async () => true),
            consumePendingEmbeddedTextUpdates: vi.fn(() => null),
            consumePendingEmbeddedAnnotationDeletes: vi.fn(() => null),
            loadRecentFiles: vi.fn(),
            clearOcrCache,
            ensureHistoryBaselineForExternalMutation,
            reloadWorkingCopyIntoHistory,
            currentPage: ref(7),
            waitForPdfReload,
            resetSearchCache,
            runWithDocumentOperationLease,
            validatePdfPath: vi.fn(async () => ({
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: [],
            })),
            saveFile: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopy: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopyAs: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document-copy.pdf',
                saveMode: 'save_as_rewrite',
                didSaveAs: true,
            })),
        }));

        const completionPromise = orchestration.handleOcrComplete({
            requestId: 'ocr-1',
            pdfPath: '/tmp/ocr-1-merged.pdf',
            sourceDocumentRevisionToken: requireDocumentRevisionToken('source-revision-token'),
            requiresCleanupAck: true,
            sourceWorkingCopyPath: '/tmp/work.pdf',
        });

        await vi.waitFor(() => {
            expect(leaseFinished).toBe(true);
        });
        expect(platformMocks.warmIndex).not.toHaveBeenCalled();

        resolveReload();
        await completionPromise;

        expect(waitForPdfReload).toHaveBeenCalledWith(7);
        expect(platformMocks.warmIndex).toHaveBeenCalledWith('/tmp/work.pdf', { pageCount: 12 });
    });

    it('reports OCR apply failures without crashing the workspace or acknowledging the result', async () => {
        platformMocks.replaceWorkingCopyFromPath.mockRejectedValueOnce(new Error('copy failed'));
        const orchestration = usePageSaveOrchestration(cast({
            pdfData: ref(null),
            pdfDocument: shallowRef({ numPages: 12 } as PDFDocumentProxy),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                saveDocument: vi.fn(async () => new Uint8Array([1])),
                getMarkupSubtypeOverrides: vi.fn(() => undefined),
                getAllShapes: vi.fn(() => []),
                getDeletedEmbeddedShapeAnnotationIds: vi.fn(() => []),
            }),
            requestDocxExport: vi.fn(async () => true),
            openOcrPopup: vi.fn(),
            isExportingDocx: ref(false),
            workingCopyPath: ref('/tmp/work.pdf'),
            documentRevisionToken: ref('revision-token'),
            annotationComments: ref([]),
            totalPages: ref(12),
            pageLabelsDirty: ref(false),
            pageLabelRanges: ref([]),
            bookmarksDirty: ref(false),
            bookmarkItems: ref([]),
            isSaving: ref(false),
            isSavingAs: ref(false),
            annotationDirty: ref(false),
            annotationNoteWindowsCount: ref(0),
            hasAnnotationChanges: vi.fn(() => false),
            markAnnotationSaved: vi.fn(),
            markPageLabelsSaved: vi.fn(),
            markBookmarksSaved: vi.fn(),
            isDirty: ref(false),
            hasPendingUnsavedChanges: computed(() => false),
            persistAllAnnotationNotes: vi.fn(async () => true),
            consumePendingEmbeddedTextUpdates: vi.fn(() => null),
            consumePendingEmbeddedAnnotationDeletes: vi.fn(() => null),
            loadRecentFiles: vi.fn(),
            clearOcrCache: vi.fn(),
            ensureHistoryBaselineForExternalMutation: vi.fn(async () => true),
            reloadWorkingCopyIntoHistory: vi.fn(async () => true),
            currentPage: ref(7),
            waitForPdfReload: vi.fn(async () => {}),
            resetSearchCache: vi.fn(),
            validatePdfPath: vi.fn(async () => ({
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: [],
            })),
            saveFile: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopy: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopyAs: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document-copy.pdf',
                saveMode: 'save_as_rewrite',
                didSaveAs: true,
            })),
        }));

        await expect(orchestration.handleOcrComplete({
            requestId: 'ocr-1',
            pdfPath: '/tmp/ocr-1-merged.pdf',
            sourceDocumentRevisionToken: requireDocumentRevisionToken('source-revision-token'),
            requiresCleanupAck: true,
            sourceWorkingCopyPath: '/tmp/work.pdf',
        })).resolves.toBeUndefined();

        expect(platformMocks.acknowledgeResultFile).not.toHaveBeenCalled();
        expect(platformMocks.cleanupOcrTemp).not.toHaveBeenCalled();
        expect(platformMocks.toastAdd).toHaveBeenCalledWith({
            color: 'error',
            title: 'errors.ocr.createSearchablePdf',
        });
    });

    it('rejects OCR apply against an advanced revision and acknowledges the result artifact', async () => {
        platformMocks.replaceWorkingCopyFromPath.mockRejectedValueOnce(createStaleRevisionError({
            documentRef: '/tmp/work.pdf',
            expectedRevision: requireDocumentRevisionToken('source-revision-token'),
            actualRevision: requireDocumentRevisionToken('revision-after-edit'),
        }));
        const orchestration = usePageSaveOrchestration(cast({
            pdfData: ref(null),
            pdfDocument: shallowRef({ numPages: 12 } as PDFDocumentProxy),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                saveDocument: vi.fn(async () => new Uint8Array([1])),
                getMarkupSubtypeOverrides: vi.fn(() => undefined),
                getAllShapes: vi.fn(() => []),
                getDeletedEmbeddedShapeAnnotationIds: vi.fn(() => []),
            }),
            requestDocxExport: vi.fn(async () => true),
            openOcrPopup: vi.fn(),
            isExportingDocx: ref(false),
            workingCopyPath: ref('/tmp/work.pdf'),
            documentRevisionToken: ref('revision-after-edit'),
            annotationComments: ref([]),
            totalPages: ref(12),
            pageLabelsDirty: ref(false),
            pageLabelRanges: ref([]),
            bookmarksDirty: ref(false),
            bookmarkItems: ref([]),
            isSaving: ref(false),
            isSavingAs: ref(false),
            annotationDirty: ref(false),
            annotationNoteWindowsCount: ref(0),
            hasAnnotationChanges: vi.fn(() => false),
            markAnnotationSaved: vi.fn(),
            markPageLabelsSaved: vi.fn(),
            markBookmarksSaved: vi.fn(),
            isDirty: ref(false),
            hasPendingUnsavedChanges: computed(() => false),
            persistAllAnnotationNotes: vi.fn(async () => true),
            consumePendingEmbeddedTextUpdates: vi.fn(() => null),
            consumePendingEmbeddedAnnotationDeletes: vi.fn(() => null),
            loadRecentFiles: vi.fn(),
            clearOcrCache: vi.fn(),
            ensureHistoryBaselineForExternalMutation: vi.fn(async () => true),
            reloadWorkingCopyIntoHistory: vi.fn(async () => true),
            currentPage: ref(7),
            waitForPdfReload: vi.fn(async () => {}),
            resetSearchCache: vi.fn(),
            validatePdfPath: vi.fn(async () => ({
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: [],
            })),
            saveFile: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopy: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopyAs: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document-copy.pdf',
                saveMode: 'save_as_rewrite',
                didSaveAs: true,
            })),
        }));

        await expect(orchestration.handleOcrComplete({
            requestId: 'ocr-1',
            pdfPath: '/tmp/ocr-1-merged.pdf',
            sourceDocumentRevisionToken: requireDocumentRevisionToken('source-revision-token'),
            requiresCleanupAck: true,
            sourceWorkingCopyPath: '/tmp/work.pdf',
        })).resolves.toBeUndefined();

        expect(platformMocks.replaceWorkingCopyFromPath).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            '/tmp/ocr-1-merged.pdf',
            { expectedDocumentRevisionToken: requireDocumentRevisionToken('source-revision-token') },
        );
        expect(platformMocks.acknowledgeResultFile).toHaveBeenCalledWith(
            'ocr-1',
            '/tmp/ocr-1-merged.pdf',
        );
        expect(platformMocks.warmIndex).not.toHaveBeenCalled();
        expect(platformMocks.toastAdd).toHaveBeenCalledWith({
            color: 'error',
            title: 'errors.ocr.changedReload',
        });
    });

    it('does not fall back to legacy OCR cleanup when cleanup acknowledgement is not required', async () => {
        const ensureHistoryBaselineForExternalMutation = vi.fn(async () => true);
        const orchestration = usePageSaveOrchestration(cast({
            pdfData: ref(null),
            pdfDocument: shallowRef({ numPages: 12 } as PDFDocumentProxy),
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                saveDocument: vi.fn(async () => new Uint8Array([1])),
                getMarkupSubtypeOverrides: vi.fn(() => undefined),
                getAllShapes: vi.fn(() => []),
                getDeletedEmbeddedShapeAnnotationIds: vi.fn(() => []),
            }),
            requestDocxExport: vi.fn(async () => true),
            openOcrPopup: vi.fn(),
            isExportingDocx: ref(false),
            workingCopyPath: ref('/tmp/work.pdf'),
            documentRevisionToken: ref('revision-token'),
            annotationComments: ref([]),
            totalPages: ref(12),
            pageLabelsDirty: ref(false),
            pageLabelRanges: ref([]),
            bookmarksDirty: ref(false),
            bookmarkItems: ref([]),
            isSaving: ref(false),
            isSavingAs: ref(false),
            annotationDirty: ref(false),
            annotationNoteWindowsCount: ref(0),
            hasAnnotationChanges: vi.fn(() => false),
            markAnnotationSaved: vi.fn(),
            markPageLabelsSaved: vi.fn(),
            markBookmarksSaved: vi.fn(),
            isDirty: ref(false),
            hasPendingUnsavedChanges: computed(() => false),
            persistAllAnnotationNotes: vi.fn(async () => true),
            consumePendingEmbeddedTextUpdates: vi.fn(() => null),
            consumePendingEmbeddedAnnotationDeletes: vi.fn(() => null),
            loadRecentFiles: vi.fn(),
            clearOcrCache: vi.fn(),
            ensureHistoryBaselineForExternalMutation,
            reloadWorkingCopyIntoHistory: vi.fn(async () => true),
            currentPage: ref(7),
            waitForPdfReload: vi.fn(async () => {}),
            resetSearchCache: vi.fn(),
            validatePdfPath: vi.fn(async () => ({
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: [],
            })),
            saveFile: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopy: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            })),
            saveWorkingCopyAs: vi.fn(async () => ({
                success: true,
                outPath: '/tmp/document-copy.pdf',
                saveMode: 'save_as_rewrite',
                didSaveAs: true,
            })),
        }));

        await orchestration.handleOcrComplete({
            requestId: 'ocr-1',
            pdfPath: '/tmp/ocr-1-merged.pdf',
            sourceDocumentRevisionToken: requireDocumentRevisionToken('source-revision-token'),
            requiresCleanupAck: false,
            sourceWorkingCopyPath: '/tmp/work.pdf',
        });

        expect(platformMocks.replaceWorkingCopyFromPath).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            '/tmp/ocr-1-merged.pdf',
            {expectedDocumentRevisionToken: requireDocumentRevisionToken('source-revision-token')},
        );
        expect(platformMocks.acknowledgeResultFile).not.toHaveBeenCalled();
        expect(platformMocks.cleanupOcrTemp).not.toHaveBeenCalled();
    });
});
