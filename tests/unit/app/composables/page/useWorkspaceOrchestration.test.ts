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

const lifecycleControllerMock = vi.fn();
const fileOperationControllerMock = vi.fn();
const sidebarControllerMock = vi.fn();
const pageLabelStateMock = vi.fn();
const bookmarkStateMock = vi.fn();
const workspaceExportMock = vi.fn();
const annotationContextMenuMock = vi.fn();
const pageContextMenuMock = vi.fn();
const annotationToolsMock = vi.fn();
const ocrTextContentMock = vi.fn();
const docxExportMock = vi.fn();
const pageSaveOrchestrationMock = vi.fn();
const workspaceViewStateMock = vi.fn();
const pdfHistoryMock = vi.fn();
const annotationNoteWindowsMock = vi.fn();
const annotationActionsMock = vi.fn();
const pageStatusBarMock = vi.fn();
const pageOpsHandlersMock = vi.fn();
const pageShortcutsMock = vi.fn();
const setupWorkspaceUiSyncWatchersMock = vi.fn();
const documentTransitionsMock = vi.fn();
const createSerializeCurrentPdfForEmbeddedFallbackMock = vi.fn();
const detectAnnotationChangesMock = vi.fn(() => false);

const hasElectronApiMock = vi.fn(() => false);
const electronApiMock = {documents: {
    readFile: vi.fn(),
    createWorkingCopyFromData: vi.fn(),
}};

const syncRefMock = vi.fn();
const useStorageMock = vi.fn(() => ref('0'));

vi.mock('@vueuse/core', () => ({
    syncRef: syncRefMock,
    useStorage: useStorageMock,
}));

vi.mock('@app/utils/electron', () => ({
    hasElectronAPI: () => hasElectronApiMock(),
    getElectronAPI: () => electronApiMock,
}));

vi.mock('@app/composables/page/workspace-file-lifecycle-controller', () => ({
    useWorkspaceFileLifecycleController: () => lifecycleControllerMock(),
    useWorkspaceFileOperationController: (...args: unknown[]) => fileOperationControllerMock(...args),
}));

vi.mock('@app/composables/page/workspace-sidebar-search-sync-controller', () => ({useWorkspaceSidebarSearchSyncController: (...args: unknown[]) => sidebarControllerMock(...args)}));

vi.mock('@app/composables/pdf/usePageLabelState', () => ({usePageLabelState: (...args: unknown[]) => pageLabelStateMock(...args)}));

vi.mock('@app/composables/pdf/useBookmarkState', () => ({useBookmarkState: (...args: unknown[]) => bookmarkStateMock(...args)}));

vi.mock('@app/composables/page/useWorkspaceExport', () => ({useWorkspaceExport: (...args: unknown[]) => workspaceExportMock(...args)}));

vi.mock('@app/composables/pdf/useAnnotationContextMenu', () => ({useAnnotationContextMenu: (...args: unknown[]) => annotationContextMenuMock(...args)}));

vi.mock('@app/composables/pdf/usePageContextMenu', () => ({usePageContextMenu: (...args: unknown[]) => pageContextMenuMock(...args)}));

vi.mock('@app/composables/usePageAnnotationTools', () => ({usePageAnnotationTools: (...args: unknown[]) => annotationToolsMock(...args)}));

vi.mock('@app/composables/pdf/useOcrTextContent', () => ({useOcrTextContent: (...args: unknown[]) => ocrTextContentMock(...args)}));

vi.mock('@app/composables/useDocxExport', () => ({useDocxExport: (...args: unknown[]) => docxExportMock(...args)}));

vi.mock('@app/composables/usePageSaveOrchestration', () => ({usePageSaveOrchestration: (...args: unknown[]) => pageSaveOrchestrationMock(...args)}));

vi.mock('@app/composables/page/workspace-view-state', () => ({useWorkspaceViewState: (...args: unknown[]) => workspaceViewStateMock(...args)}));

vi.mock('@app/composables/usePdfHistory', () => ({usePdfHistory: (...args: unknown[]) => pdfHistoryMock(...args)}));

vi.mock('@app/composables/pdf/useAnnotationNoteWindows', () => ({useAnnotationNoteWindows: (...args: unknown[]) => annotationNoteWindowsMock(...args)}));

vi.mock('@app/composables/usePageAnnotationActions', () => ({usePageAnnotationActions: (...args: unknown[]) => annotationActionsMock(...args)}));

vi.mock('@app/composables/usePageStatusBar', () => ({usePageStatusBar: (...args: unknown[]) => pageStatusBarMock(...args)}));

vi.mock('@app/composables/usePageOpsHandlers', () => ({usePageOpsHandlers: (...args: unknown[]) => pageOpsHandlersMock(...args)}));

vi.mock('@app/composables/usePageShortcuts', () => ({usePageShortcuts: (...args: unknown[]) => pageShortcutsMock(...args)}));

vi.mock('@app/composables/page/workspace-ui-sync', () => ({setupWorkspaceUiSyncWatchers: (...args: unknown[]) => setupWorkspaceUiSyncWatchersMock(...args)}));

vi.mock('@app/composables/page/useDocumentTransitions', () => ({useDocumentTransitions: (...args: unknown[]) => documentTransitionsMock(...args)}));

vi.mock('@app/composables/page/workspace-annotation-utils', () => ({
    createSerializeCurrentPdfForEmbeddedFallback: createSerializeCurrentPdfForEmbeddedFallbackMock,
    hasAnnotationChanges: detectAnnotationChangesMock,
}));

function noop() {
    return;
}

function createLifecycleControllerState() {
    return {
        isDjvuMode: ref(false),
        djvuSourcePath: ref<string | null>(null),
        conversionState: ref('idle'),
        djvuIsLoadingPages: ref(false),
        djvuLoadingProgress: ref(0),
        djvuShowBanner: ref(false),
        showConvertDialog: ref(false),
        djvuError: ref<string | null>(null),
        openDjvuFile: vi.fn(async () => {}),
        openConvertDialog: vi.fn(),
        djvuDismissBanner: vi.fn(),
        handleDjvuConvert: vi.fn(async () => {}),
        handleDjvuCancel: vi.fn(),
        recentFiles: ref([]),
        loadRecentFiles: vi.fn(),
        removeRecentFile: vi.fn(),
        clearRecentFiles: vi.fn(),
        pickFileToOpenWithDjvuCleanup: vi.fn(async () => null),
        openFileWithDjvuCleanup: vi.fn(async () => {}),
        openFileDirectWithDjvuCleanup: vi.fn(async () => {}),
        openFileDirectBatchWithDjvuCleanup: vi.fn(async () => {}),
        closeFileWithDjvuCleanup: vi.fn(async () => {}),
        hasPdf: ref(false),
        initFromStorage: vi.fn(),
        pdfSrc: ref<string | null>(null),
        pdfData: ref<Uint8Array | null>(null),
        workingCopyPath: ref<string | null>(null),
        originalPath: ref<string | null>(null),
        fileName: ref<string | null>('sample.pdf'),
        isDirty: ref(false),
        pdfError: ref<string | null>(null),
        isElectron: ref(false),
        pendingDjvu: ref<string | null>(null),
        openBatchProgress: ref(null),
        loadPdfFromPath: vi.fn(async () => {}),
        loadPdfFromData: vi.fn(async () => {}),
        saveFile: vi.fn(async () => true),
        saveWorkingCopy: vi.fn(async () => true),
        saveWorkingCopyAs: vi.fn(async () => '/tmp/new.pdf'),
        markDirty: vi.fn(),
        canUndoFile: ref(false),
        canRedoFile: ref(false),
        undo: vi.fn(async () => {}),
        redo: vi.fn(async () => {}),
    };
}

function createSidebarControllerState() {
    const viewer = {
        saveDocument: vi.fn(async () => null),
        updateAnnotationComment: vi.fn(() => true),
        captureRegionToClipboard: vi.fn(async () => {}),
        isCapturingRegion: ref(false),
    };

    return {
        pdfViewerRef: ref(viewer),
        zoomDropdownOpen: ref(false),
        pageDropdownOpen: ref(false),
        ocrPopupOpen: ref(false),
        overflowMenuOpen: ref(false),
        closeAllDropdowns: vi.fn(),
        closeOtherDropdowns: vi.fn(),
        handleDropdownOpenChange: vi.fn(),
        openDropdown: vi.fn(),
        selectedThumbnailPages: ref<number[]>([]),
        thumbnailInvalidationRequest: ref(null),
        setSelectedThumbnailPages: vi.fn(),
        requestThumbnailInvalidation: vi.fn(),
        handleSelectedThumbnailPagesUpdate: vi.fn(),
        zoom: ref(1),
        fitMode: ref<'fit-width' | 'fit-height' | 'none'>('none'),
        viewMode: ref<'single' | 'continuous'>('single'),
        currentPage: ref(1),
        totalPages: ref(1),
        pdfDocument: shallowRef(null),
        isLoading: ref(false),
        dragMode: ref(false),
        continuousScroll: ref(false),
        showSidebar: ref(false),
        showSettings: ref(false),
        sidebarTab: ref<'annotations' | 'thumbnails' | 'bookmarks' | 'search'>('thumbnails'),
        searchQuery: ref(''),
        results: ref([]),
        pageMatches: ref(new Map()),
        currentResultIndex: ref(-1),
        currentResult: ref(null),
        isSearching: ref(false),
        totalMatches: ref(0),
        searchProgress: ref(undefined),
        isTruncated: ref(false),
        minQueryLength: 2,
        openSearch: vi.fn(),
        openAnnotations: vi.fn(),
        closeSearch: vi.fn(),
        handleSearch: vi.fn(async () => false),
        handleSearchNext: vi.fn(),
        handleSearchPrevious: vi.fn(),
        handleGoToResult: vi.fn(),
        resetSearchCache: vi.fn(),
        sidebarWidth: ref(320),
        sidebarWrapperStyle: ref({}),
        isResizingSidebar: ref(false),
        startSidebarResize: vi.fn(),
        cleanupSidebarResizeListeners: vi.fn(),
    };
}

function createDefaults() {
    const lifecycle = createLifecycleControllerState();
    const sidebar = createSidebarControllerState();

    lifecycleControllerMock.mockReturnValue(lifecycle);
    sidebarControllerMock.mockReturnValue(sidebar);

    fileOperationControllerMock.mockReturnValue({
        handleOpenFileFromUi: vi.fn(async () => {}),
        handleOpenFileDirectWithPersist: vi.fn(async () => {}),
        handleOpenFileDirectBatchWithPersist: vi.fn(async () => {}),
        handleOpenFileWithResult: vi.fn(async () => {}),
        handleCloseFileFromUi: vi.fn(async () => {}),
        openRecentFile: vi.fn(async () => {}),
    });

    pageLabelStateMock.mockReturnValue({
        pageLabels: ref([]),
        pageLabelRanges: ref([]),
        pageLabelsDirty: ref(false),
        markPageLabelsSaved: vi.fn(),
        handlePageLabelRangesUpdate: vi.fn(),
    });

    bookmarkStateMock.mockReturnValue({
        bookmarkItems: ref([]),
        bookmarksDirty: ref(false),
        bookmarkEditMode: ref(false),
        markBookmarksSaved: vi.fn(),
        handleBookmarksChange: vi.fn(),
    });

    workspaceExportMock.mockReturnValue({
        isExportInProgress: ref(false),
        exportScopeDialogOpen: ref(false),
        exportScopeDialogMode: ref('images'),
        exportScopeDialogSelectedPages: ref<number[]>([]),
        handleExportScopeDialogSubmit: vi.fn(),
        handleExportScopeDialogOpenChange: vi.fn(),
        handleExportImages: vi.fn(async () => {}),
        handleExportMultiPageTiff: vi.fn(async () => {}),
    });

    annotationContextMenuMock.mockReturnValue({
        annotationContextMenu: ref({
            visible: false,
            comment: null,
            hasSelection: false,
            selectionText: '',
            pageNumber: null,
            pageX: null,
            pageY: null,
        }),
        annotationContextMenuStyle: ref({}),
        annotationContextMenuCanCopy: ref(false),
        annotationContextMenuCanCopySelection: ref(false),
        annotationContextMenuCanCreateFree: ref(false),
        contextMenuAnnotationLabel: ref(''),
        contextMenuDeleteActionLabel: ref(''),
        closeAnnotationContextMenu: vi.fn(),
        showAnnotationContextMenu: vi.fn(),
    });

    pageContextMenuMock.mockReturnValue({
        pageContextMenu: ref({ visible: false }),
        pageContextMenuStyle: ref({}),
        showPageContextMenu: vi.fn(),
        closePageContextMenu: vi.fn(),
    });

    annotationToolsMock.mockReturnValue({
        annotationTool: ref<'none'>('none'),
        annotationKeepActive: ref(true),
        annotationPlacingPageNote: ref(false),
        annotationSettings: ref({}),
        annotationComments: ref([]),
        annotationActiveCommentStableKey: ref<string | null>(null),
        annotationEditorState: ref({
            isEditing: false,
            isEmpty: true,
            hasSomethingToUndo: false,
            hasSomethingToRedo: false,
            hasSelectedEditor: false,
        }),
        annotationDirty: ref(false),
        handleAnnotationToolChange: vi.fn(),
        handleAnnotationToolAutoReset: vi.fn(),
        handleAnnotationToolCancel: vi.fn(),
        handleAnnotationSettingChange: vi.fn(),
        handleAnnotationState: vi.fn(),
        handleAnnotationModified: vi.fn(),
        markAnnotationDirty: vi.fn(),
        markAnnotationSaved: vi.fn(),
        resetAnnotationTracking: vi.fn(),
    });

    ocrTextContentMock.mockReturnValue({clearCache: vi.fn()});

    docxExportMock.mockReturnValue({
        isExportingDocx: ref(false),
        docxExportError: ref<string | null>(null),
        exportDocx: vi.fn(async () => true),
        clearDocxExportError: vi.fn(),
    });

    pageSaveOrchestrationMock.mockReturnValue({
        handleSave: vi.fn(async () => {}),
        handleSaveAs: vi.fn(async () => {}),
        handleExportDocx: vi.fn(async () => {}),
        handleOcrComplete: vi.fn(async () => {}),
        isAnySaving: ref(false),
        isExportingDocx: ref(false),
        canSave: ref(true),
        updateEmbeddedByRef: vi.fn(async () => true),
        deleteEmbeddedByRef: vi.fn(async () => null),
    });

    workspaceViewStateMock.mockReturnValue({
        isFitWidthActive: ref(false),
        isFitHeightActive: ref(false),
        isAnnotationUndoContext: ref(false),
        annotationCursorMode: ref('text'),
        canUndo: ref(false),
        canRedo: ref(false),
        handleFitMode: vi.fn(),
        enableDragMode: vi.fn(),
        handleGoToPage: vi.fn(),
    });

    pdfHistoryMock.mockReturnValue({
        waitForPdfReload: vi.fn(async () => {}),
        handleUndo: vi.fn(async () => {}),
        handleRedo: vi.fn(async () => {}),
    });

    createSerializeCurrentPdfForEmbeddedFallbackMock.mockReturnValue(vi.fn(async () => true));

    annotationNoteWindowsMock.mockReturnValue({
        annotationNoteWindows: ref([]),
        annotationNotePositions: ref({}),
        sortedAnnotationNoteWindows: ref([]),
        isAnyAnnotationNoteSaving: ref(false),
        updateAnnotationNoteText: vi.fn(),
        updateAnnotationNotePosition: vi.fn(),
        minimizeAnnotationNote: vi.fn(),
        restoreAnnotationNote: vi.fn(),
        persistAllAnnotationNotes: vi.fn(async () => true),
        closeAnnotationNote: vi.fn(),
        closeAllAnnotationNotes: vi.fn(),
        handleOpenAnnotationNote: vi.fn(),
        removeAnnotationNoteWindow: vi.fn(),
        setAnnotationNoteWindowError: vi.fn(),
        bringAnnotationNoteToFront: vi.fn(),
        isSameAnnotationComment: vi.fn(() => false),
    });

    annotationActionsMock.mockReturnValue({
        shapePropertiesPopover: ref({
            visible: false,
            x: 0,
            y: 0,
        }),
        selectedShapeForProperties: ref(null),
        handleCommentSelection: vi.fn(),
        handleQuickNoteAction: vi.fn(),
        handleStartPlaceNote: vi.fn(),
        handleAnnotationFocusComment: vi.fn(),
        handleAnnotationCommentClick: vi.fn(),
        handleOpenAnnotationNote: vi.fn(),
        closeShapeProperties: vi.fn(),
        handleShapePropertyUpdate: vi.fn(),
        handleShapeContextMenu: vi.fn(),
        handleViewerAnnotationContextMenu: vi.fn(),
        openContextMenuNote: vi.fn(),
        copyContextMenuNoteText: vi.fn(),
        copyContextMenuSelectionText: vi.fn(),
        deleteContextMenuComment: vi.fn(),
        createContextMenuFreeNote: vi.fn(),
        createContextMenuSelectionNote: vi.fn(),
        createContextMenuMarkup: vi.fn(),
        handleCopyAnnotationComment: vi.fn(),
        handleDeleteAnnotationComment: vi.fn(),
    });

    pageStatusBarMock.mockReturnValue({
        statusFilePath: ref(''),
        statusFileSizeLabel: ref(''),
        statusZoomLabel: ref(''),
        statusCanShowInFolder: ref(false),
        statusShowInFolderTooltip: ref(''),
        statusShowInFolderAriaLabel: ref(''),
        statusSaveDotClass: ref(''),
        statusSaveDotCanSave: ref(false),
        statusSaveDotTooltip: ref(''),
        statusSaveDotAriaLabel: ref(''),
        handleStatusSaveClick: vi.fn(),
        handleStatusShowInFolderClick: vi.fn(),
    });

    pageOpsHandlersMock.mockReturnValue({
        isPageOperationInProgress: ref(false),
        pageOpsDelete: vi.fn(),
        pageOpsExtract: vi.fn(),
        pageOpsInsert: vi.fn(),
        pageOpsReorder: vi.fn(),
        handlePageContextMenuDelete: vi.fn(),
        handlePageContextMenuExtract: vi.fn(),
        handlePageContextMenuExport: vi.fn(),
        handlePageRotate: vi.fn(),
        handlePageContextMenuRotateCw: vi.fn(),
        handlePageContextMenuRotateCcw: vi.fn(),
        handlePageContextMenuInsertBefore: vi.fn(),
        handlePageContextMenuInsertAfter: vi.fn(),
        handlePageFileDrop: vi.fn(),
        handlePageContextMenuSelectAll: vi.fn(),
        handlePageContextMenuInvertSelection: vi.fn(),
    });

    pageShortcutsMock.mockReturnValue({
        setupShortcuts: vi.fn(),
        cleanupShortcuts: vi.fn(),
    });

    setupWorkspaceUiSyncWatchersMock.mockImplementation(noop);
    documentTransitionsMock.mockImplementation(noop);

    return {
        lifecycle,
        sidebar,
    };
}

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    hasElectronApiMock.mockReturnValue(false);
    electronApiMock.documents.readFile.mockResolvedValue(new Uint8Array([
        4,
        5,
        6,
    ]));
    electronApiMock.documents.createWorkingCopyFromData.mockResolvedValue('/tmp/working-copy.pdf');
    detectAnnotationChangesMock.mockReturnValue(false);

    vi.stubGlobal('useSettings', () => ({settings: ref({
        theme: 'light',
        locale: 'en',
    })}));
});

describe('useWorkspaceOrchestration', () => {
    it('wires controllers and clears docx errors when OCR dropdown opens', async () => {
        const { sidebar } = createDefaults();
        const { useWorkspaceOrchestration } = await import('@app/modules/workspace-shell/service');

        const emit = vi.fn();
        const orchestration = useWorkspaceOrchestration({
            isActive: ref(true),
            emit,
        });

        orchestration.handleDropdownOpen('ocr', true);

        expect(lifecycleControllerMock).toHaveBeenCalledOnce();
        expect(sidebarControllerMock).toHaveBeenCalledOnce();
        expect(sidebar.handleDropdownOpenChange).toHaveBeenCalledWith('ocr', true);
        expect(docxExportMock.mock.results[0]?.value.clearDocxExportError).toHaveBeenCalledOnce();
    });

    it('captures a djvu split payload when in djvu mode', async () => {
        const { lifecycle } = createDefaults();
        lifecycle.pdfSrc.value = '/tmp/source.djvu';
        lifecycle.isDjvuMode.value = true;
        lifecycle.djvuSourcePath.value = '/tmp/source.djvu';

        const { useWorkspaceOrchestration } = await import('@app/modules/workspace-shell/service');
        const orchestration = useWorkspaceOrchestration({
            isActive: ref(true),
            emit: vi.fn(),
        });

        const payload = await orchestration.captureSplitPayload();

        expect(payload).toEqual({
            kind: 'djvu',
            sourcePath: '/tmp/source.djvu',
        });
    });

    it('captures pdf snapshot via working-copy fallback when electron API is available', async () => {
        const {
            lifecycle,
            sidebar,
        } = createDefaults();
        hasElectronApiMock.mockReturnValue(true);

        lifecycle.pdfSrc.value = '/tmp/work.pdf';
        lifecycle.workingCopyPath.value = '/tmp/working-copy.pdf';
        lifecycle.fileName.value = 'work.pdf';
        lifecycle.originalPath.value = '/tmp/original.pdf';
        lifecycle.isDirty.value = true;
        sidebar.pdfViewerRef.value.saveDocument.mockResolvedValue(null);
        lifecycle.pdfData.value = null;

        const { useWorkspaceOrchestration } = await import('@app/modules/workspace-shell/service');
        const orchestration = useWorkspaceOrchestration({
            isActive: ref(true),
            emit: vi.fn(),
        });

        const payload = await orchestration.captureSplitPayload();

        expect(electronApiMock.documents.readFile).toHaveBeenCalledWith('/tmp/working-copy.pdf');
        expect(payload).toEqual({
            kind: 'pdfSnapshot',
            fileName: 'work.pdf',
            originalPath: '/tmp/original.pdf',
            data: new Uint8Array([
                4,
                5,
                6,
            ]),
            isDirty: true,
            currentPage: 1,
            totalPages: 1,
        });
    });

    it('restores pdf snapshots through data load when electron API is unavailable', async () => {
        const { lifecycle } = createDefaults();
        hasElectronApiMock.mockReturnValue(false);

        const { useWorkspaceOrchestration } = await import('@app/modules/workspace-shell/service');
        const orchestration = useWorkspaceOrchestration({
            isActive: ref(true),
            emit: vi.fn(),
        });

        const data = new Uint8Array([
            9,
            8,
            7,
        ]);

        await orchestration.restoreSplitPayload({
            kind: 'pdfSnapshot',
            fileName: 'restored.pdf',
            originalPath: '/tmp/restored.pdf',
            data,
            isDirty: true,
            currentPage: 6,
        });

        expect(lifecycle.loadPdfFromData).toHaveBeenCalledWith(new Uint8Array([
            9,
            8,
            7,
        ]), {
            pushHistory: true,
            persistWorkingCopy: false,
        });
        expect(lifecycle.markDirty).toHaveBeenCalledOnce();
        expect(lifecycle.originalPath.value).toBe('/tmp/restored.pdf');
        const historyState = pdfHistoryMock.mock.results[pdfHistoryMock.mock.results.length - 1]?.value;
        expect(historyState?.waitForPdfReload).toHaveBeenCalledWith(6);
    });

    it('restores snapshots through working-copy creation when electron API is available', async () => {
        const { lifecycle } = createDefaults();
        hasElectronApiMock.mockReturnValue(true);

        const { useWorkspaceOrchestration } = await import('@app/modules/workspace-shell/service');
        const orchestration = useWorkspaceOrchestration({
            isActive: ref(true),
            emit: vi.fn(),
        });

        await orchestration.restoreSplitPayload({
            kind: 'pdfSnapshot',
            fileName: 'restored.pdf',
            originalPath: '/tmp/original.pdf',
            data: new Uint8Array([
                1,
                2,
            ]),
            isDirty: false,
            currentPage: 4,
        });

        expect(electronApiMock.documents.createWorkingCopyFromData).toHaveBeenCalledWith(
            'restored.pdf',
            new Uint8Array([
                1,
                2,
            ]),
            '/tmp/original.pdf',
        );
        expect(lifecycle.loadPdfFromPath).toHaveBeenCalledWith('/tmp/working-copy.pdf', { markDirty: false });
        expect(lifecycle.originalPath.value).toBe('/tmp/original.pdf');
        const historyState = pdfHistoryMock.mock.results[pdfHistoryMock.mock.results.length - 1]?.value;
        expect(historyState?.waitForPdfReload).toHaveBeenCalledWith(4);
    });
});
