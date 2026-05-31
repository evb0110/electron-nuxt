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
    handleSaveAs: ReturnType<typeof vi.fn>;
} => ({
    capturedDeps: null,
    handleSave: vi.fn(),
    handleSaveAs: vi.fn(),
}));

vi.mock('@app/composables/useFileOperations', () => ({useFileOperations: vi.fn((deps: unknown) => {
    fileOperationMocks.capturedDeps = deps;
    return {
        handleSave: fileOperationMocks.handleSave,
        handleSaveAs: fileOperationMocks.handleSaveAs,
    };
})}));

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
});
