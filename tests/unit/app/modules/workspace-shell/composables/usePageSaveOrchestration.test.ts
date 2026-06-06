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
import type { IScrollSnapshot } from '@app/types/pdf';
import { cast } from '@tests/helpers/cast';

const fileOperationMocks = vi.hoisted((): {
    capturedDeps: unknown;
    handleSave: ReturnType<typeof vi.fn>;
    handleRepairSave: ReturnType<typeof vi.fn>;
    handleSaveAs: ReturnType<typeof vi.fn>;
} => ({
    capturedDeps: null,
    handleSave: vi.fn(),
    handleRepairSave: vi.fn(),
    handleSaveAs: vi.fn(),
}));
const platformMocks = vi.hoisted(() => ({
    replaceWorkingCopyFromPath: vi.fn(),
    cleanupOcrTemp: vi.fn(),
    acknowledgeResultFile: vi.fn(),
    warmIndex: vi.fn(),
}));

vi.mock('@app/composables/useFileOperations', () => ({useFileOperations: vi.fn((deps: unknown) => {
    fileOperationMocks.capturedDeps = deps;
    return {
        handleSave: fileOperationMocks.handleSave,
        handleRepairSave: fileOperationMocks.handleRepairSave,
        handleSaveAs: fileOperationMocks.handleSaveAs,
    };
})}));
vi.mock('@app/utils/platformDocuments', () => ({getDocumentsCapability: () => ({
    replaceWorkingCopyFromPath: platformMocks.replaceWorkingCopyFromPath,
    cleanupOcrTemp: platformMocks.cleanupOcrTemp,
})}));
vi.mock('@app/utils/getOcrCapability', () => ({getOcrCapability: () => ({acknowledgeResultFile: platformMocks.acknowledgeResultFile})}));
vi.mock('@app/utils/getSearchCapability', () => ({getSearchCapability: () => ({warmIndex: platformMocks.warmIndex})}));

vi.mock('@app/composables/pdf/usePdfSerialization', () => ({usePdfSerialization: () => ({
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
        platformMocks.acknowledgeResultFile.mockResolvedValue({ cleaned: true });
        platformMocks.warmIndex.mockResolvedValue(undefined);
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
        vi.stubGlobal('useToast', () => ({ add: vi.fn() }));
    });

    it('arms preserved PDF reloads without rewriting the workspace current page', () => {
        const currentPage = ref(41);
        const scrollSnapshot: IScrollSnapshot = {
            width: 800,
            height: 4000,
            centerX: 300,
            centerY: 2100,
            anchorPage: 42,
            anchorInsidePage: true,
            anchorOffsetRatio: 0.25,
            anchorViewportX: 300,
            anchorViewportY: 500,
            anchorContentXRatio: 0.375,
            anchorContentYRatio: 0.525,
            anchorPageXRatio: 0.5,
            anchorPageYRatio: 0.25,
            anchorPageYOutsideEdge: 'inside',
            anchorPageYOutsideOffsetPx: null,
        };
        const preserveNextSourceReloadVisibleContent = vi.fn();
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
            annotationComments: ref([]),
            totalPages: ref(50),
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

        const capturedDeps = cast<{ preparePostSaveReload: () => { cancel: () => void }; }>(
            fileOperationMocks.capturedDeps,
        );
        const reloadWaiter = capturedDeps.preparePostSaveReload();
        reloadWaiter.cancel();

        expect(currentPage.value).toBe(41);
        expect(preserveNextSourceReloadVisibleContent).toHaveBeenCalledWith({
            scrollSnapshot,
            pageToRestore: 42,
        });
    });

    it('applies OCR results by replacing the working copy from the temp PDF path', async () => {
        const clearOcrCache = vi.fn();
        const resetSearchCache = vi.fn();
        const reloadWorkingCopyIntoHistory = vi.fn(async () => true);
        const waitForPdfReload = vi.fn(async () => {});
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
            reloadWorkingCopyIntoHistory,
            currentPage: ref(7),
            waitForPdfReload,
            resetSearchCache,
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
            requiresCleanupAck: true,
            sourceWorkingCopyPath: '/tmp/work.pdf',
        });

        expect(clearOcrCache).toHaveBeenCalledWith('/tmp/work.pdf');
        expect(resetSearchCache).toHaveBeenCalledTimes(1);
        expect(waitForPdfReload).toHaveBeenCalledWith(7);
        expect(platformMocks.replaceWorkingCopyFromPath).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            '/tmp/ocr-1-merged.pdf',
        );
        expect(reloadWorkingCopyIntoHistory).toHaveBeenCalledWith({ markDirty: true });
        expect(platformMocks.acknowledgeResultFile).toHaveBeenCalledWith(
            'ocr-1',
            '/tmp/ocr-1-merged.pdf',
        );
        expect(platformMocks.cleanupOcrTemp).not.toHaveBeenCalled();
        expect(platformMocks.warmIndex).toHaveBeenCalledWith('/tmp/work.pdf', { pageCount: 12 });
    });
});
