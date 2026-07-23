import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
} from 'vue';
import { createWorkspaceExpose } from '@app/modules/workspace-shell/expose/createWorkspaceExpose';
import { createDefaultWorkspaceViewerCapabilities } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentViewerNavigationPort } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import { cast } from '@tests/helpers/cast';

function createDeps(overrides: Partial<Parameters<typeof createWorkspaceExpose>[0]> = {}) {
    return cast<Parameters<typeof createWorkspaceExpose>[0]>({
        handleSave: vi.fn(async () => {}),
        handleRepairSave: vi.fn(async () => {}),
        handleOptimizePdfForInteraction: vi.fn(async () => {}),
        handleSaveAs: vi.fn(async () => {}),
        handlePrint: vi.fn(async () => {}),
        handlePrintCurrentPage: vi.fn(async () => {}),
        handleUndo: vi.fn(),
        handleRedo: vi.fn(),
        handleCombineImages: vi.fn(async () => true),
        handleOpenFileFromUi: vi.fn(async () => true),
        handleOpenFileDirectWithPersist: vi.fn(async (_path: string) => true),
        handleOpenFileDirectBatchWithPersist: vi.fn(async (_paths: string[]) => true),
        handleOpenFileWithResult: vi.fn(async () => true),
        handleCloseFileFromUi: vi.fn(async () => {}),
        openRecentFile: vi.fn(async () => true),
        handleExportDocx: vi.fn(async () => {}),
        handleExportImages: vi.fn(async () => {}),
        handleExportMultiPageTiff: vi.fn(async () => {}),
        hasPdf: ref(false),
        isOpeningDocument: ref(false),
        initialVisualReady: ref(false),
        hasOpenError: ref(false),
        isPreparingPrint: ref(false),
        isPreparingCurrentPagePrint: ref(false),
        canSave: ref(false),
        canUndo: ref(false),
        canRedo: ref(false),
        canExportDocx: ref(false),
        isSaving: ref(false),
        isSavingAs: ref(false),
        isAnySaving: ref(false),
        isHistoryBusy: ref(false),
        isExportingDocx: ref(false),
        isFitWidthActive: ref(false),
        isFitHeightActive: ref(false),
        showSidebar: ref(false),
        dragMode: ref(false),
        continuousScroll: ref(false),
        isCapturingRegion: ref(false),
        isCropSelecting: ref(false),
        isPlacingPageNote: ref(false),
        closeAllDropdowns: vi.fn(),
        zoom: ref(1),
        effectiveZoom: ref(1),
        zoomMode: ref('custom'),
        fitMode: ref('width'),
        viewMode: ref('single'),
        currentPage: ref(1),
        handleFitMode: vi.fn(),
        handleGoToPage: vi.fn(),
        handleToggleSidebar: vi.fn(),
        handleToggleContinuousScroll: vi.fn(),
        handleEnableDragMode: vi.fn(),
        handleDisableDragMode: vi.fn(),
        handleCaptureRegion: vi.fn(),
        handleCrop: vi.fn(),
        handleQuickNote: vi.fn(),
        handleInsertImageFromFile: vi.fn(async () => {}),
        handlePasteImageFromClipboard: vi.fn(async () => {}),
        selectedThumbnailPages: ref<number[]>([]),
        pageOpsDelete: vi.fn(async (_pages: number[], _totalPages: number) => {}),
        pageOpsExtract: vi.fn(async (_pages: number[]) => {}),
        handlePageRotate: vi.fn(async (_pages: number[], _angle: 90 | 270) => {}),
        pageOpsInsert: vi.fn(async (_totalPages: number, _afterPage: number) => {}),
        totalPages: ref(7),
        isDjvuMode: ref(false),
        openConvertDialog: vi.fn(),
        captureSplitPayload: vi.fn(async () => ({})),
        restoreSplitPayload: vi.fn(async () => {}),
        waitForDocumentOpenSettled: vi.fn(async () => {}),
        runAgentAction: vi.fn(async () => ({})),
        readAgentResource: vi.fn(async () => ({})),
        workingCopyPath: ref(null),
        originalPath: ref(null),
        pdfData: ref(null),
        pdfReloadSrc: ref(null),
        annotationComments: ref([]),
        annotationCommentsStatus: ref('ready'),
        annotationDirty: ref(false),
        sortedAnnotationNoteWindows: ref([]),
        handleOcrComplete: vi.fn(async () => {}),
        ...overrides,
    });
}

describe('createWorkspaceExpose', () => {
    it('reports path-backed PDF ownership without exposing bytes', () => {
        const deps = createDeps({
            pdfData: ref(null),
            pdfReloadSrc: ref({
                kind: 'path',
                path: '/tmp/working.pdf',
                size: 4_096,
            }),
        });

        expect(createWorkspaceExpose(deps).getAutomationStateSnapshot().pdfSourceState)
            .toEqual({
                hasInMemoryData: false,
                reloadKind: 'path',
                reloadPath: '/tmp/working.pdf',
            });
    });

    it('runs save only when the toolbar save command is enabled', async () => {
        const deps = createDeps({
            hasPdf: ref(true),
            canSave: ref(true),
        });
        const exposed = createWorkspaceExpose(deps);

        await exposed.handleSave();

        expect(deps.handleSave).toHaveBeenCalledOnce();
    });

    it('ignores save shortcuts when the toolbar save command is disabled', async () => {
        const deps = createDeps({
            hasPdf: ref(true),
            canSave: ref(false),
        });
        const exposed = createWorkspaceExpose(deps);

        await exposed.handleSave();

        expect(deps.handleSave).not.toHaveBeenCalled();
    });

    it('runs repair save when a PDF is open even if ordinary save is disabled', async () => {
        const deps = createDeps({
            hasPdf: ref(true),
            canSave: ref(false),
        });
        const exposed = createWorkspaceExpose(deps);

        await exposed.handleRepairSave();

        expect(deps.handleRepairSave).toHaveBeenCalledOnce();
        expect(exposed.getToolbarSnapshot().canRepairSave).toBe(true);
    });

    it('runs PDF optimization when a PDF is open even if ordinary save is disabled', async () => {
        const deps = createDeps({
            hasPdf: ref(true),
            canSave: ref(false),
        });
        const exposed = createWorkspaceExpose(deps);

        await exposed.handleOptimizePdfForInteraction();

        expect(deps.handleOptimizePdfForInteraction).toHaveBeenCalledOnce();
    });

    it('ignores save while another save operation is active', async () => {
        const deps = createDeps({
            hasPdf: ref(true),
            canSave: ref(true),
            isAnySaving: ref(true),
        });
        const exposed = createWorkspaceExpose(deps);

        await exposed.handleSave();

        expect(deps.handleSave).not.toHaveBeenCalled();
    });

    it('clamps zoom in/out commands', () => {
        const deps = createDeps({
            zoom: ref(9.9),
            effectiveZoom: ref(9.9),
        });
        const exposed = createWorkspaceExpose(deps);

        exposed.handleZoomIn();
        exposed.handleZoomIn();
        expect(deps.zoom.value).toBe(10);
        expect(deps.zoomMode.value).toBe('custom');

        deps.zoom.value = 0.3;
        deps.effectiveZoom.value = 0.3;
        exposed.handleZoomOut();
        exposed.handleZoomOut();
        expect(deps.zoom.value).toBe(0.25);
    });

    it('converts fit zoom steps into custom zoom based on effective zoom', () => {
        const deps = createDeps({
            zoom: ref(1),
            effectiveZoom: ref(2.5),
            zoomMode: ref('fit-width'),
            fitMode: ref('width'),
        });
        const exposed = createWorkspaceExpose(deps);

        exposed.handleZoomIn();

        expect(deps.zoom.value).toBeCloseTo(2.75, 6);
        expect(deps.effectiveZoom.value).toBeCloseTo(2.75, 6);
        expect(deps.zoomMode.value).toBe('custom');
    });

    it('exposes exact custom display zoom for automation', () => {
        const deps = createDeps({
            zoom: ref(1),
            effectiveZoom: ref(1),
            zoomMode: ref('fit-width'),
        });
        const exposed = createWorkspaceExpose(deps);

        exposed.setCustomZoomFromDisplay(0.29);

        expect(deps.zoom.value).toBeCloseTo(0.29, 6);
        expect(deps.effectiveZoom.value).toBeCloseTo(0.29, 6);
        expect(deps.zoomMode.value).toBe('custom');
    });

    it('does not jump upward when zooming out from fit below the manual minimum', () => {
        const deps = createDeps({
            zoom: ref(1),
            effectiveZoom: ref(0.12),
            zoomMode: ref('fit-height'),
            fitMode: ref('height'),
        });
        const exposed = createWorkspaceExpose(deps);

        exposed.handleZoomOut();

        expect(deps.zoom.value).toBe(1);
        expect(deps.effectiveZoom.value).toBe(0.12);
        expect(deps.zoomMode.value).toBe('fit-height');
    });

    it('routes fit commands through handleFitMode', () => {
        const deps = createDeps();
        const exposed = createWorkspaceExpose(deps);

        exposed.handleFitWidth();
        exposed.handleFitHeight();

        expect(deps.handleFitMode).toHaveBeenNthCalledWith(1, 'width');
        expect(deps.handleFitMode).toHaveBeenNthCalledWith(2, 'height');
    });

    it('ignores view controls that the active viewer cannot honor', () => {
        const deps = createDeps({
            hasPdf: ref(true),
            viewerCapabilities: ref({
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
                pdfDocument: true,
                print: true,
            }),
        });
        const exposed = createWorkspaceExpose(deps);

        exposed.handleToggleContinuousScroll();
        exposed.handleViewModeFacing();
        exposed.handleViewModeFacingFirstSingle();

        expect(deps.handleToggleContinuousScroll).not.toHaveBeenCalled();
        expect(deps.viewMode.value).toBe('single');
    });

    it('runs page actions only when pages are selected', async () => {
        const deps = createDeps();
        const exposed = createWorkspaceExpose(deps);

        exposed.handleDeletePages();
        exposed.handleExtractPages();
        exposed.handleRotateCw();
        exposed.handleRotateCcw();

        expect(deps.pageOpsDelete).not.toHaveBeenCalled();
        expect(deps.pageOpsExtract).not.toHaveBeenCalled();
        expect(deps.handlePageRotate).not.toHaveBeenCalled();

        deps.selectedThumbnailPages.value = [
            1,
            3,
        ];

        exposed.handleDeletePages();
        exposed.handleExtractPages();
        exposed.handleRotateCw();
        exposed.handleRotateCcw();

        expect(deps.pageOpsDelete).toHaveBeenCalledWith([
            1,
            3,
        ], 7);
        expect(deps.pageOpsExtract).toHaveBeenCalledWith([
            1,
            3,
        ]);
        expect(deps.handlePageRotate).toHaveBeenNthCalledWith(1, [
            1,
            3,
        ], 90);
        expect(deps.handlePageRotate).toHaveBeenNthCalledWith(2, [
            1,
            3,
        ], 270);
    });

    it('opens conversion dialog in DjVu mode and file picker otherwise', async () => {
        const deps = createDeps({ isDjvuMode: ref(true) });
        const exposed = createWorkspaceExpose(deps);

        exposed.handleConvertToPdf();
        expect(deps.openConvertDialog).toHaveBeenCalledOnce();
        expect(deps.handleOpenFileFromUi).not.toHaveBeenCalled();

        deps.isDjvuMode.value = false;
        exposed.handleConvertToPdf();
        expect(deps.handleOpenFileFromUi).toHaveBeenCalledOnce();
    });

    it('suppresses region capture in DjVu mode', () => {
        const deps = createDeps({ isDjvuMode: ref(true) });
        const exposed = createWorkspaceExpose(deps);

        exposed.handleCaptureRegion();
        expect(deps.handleCaptureRegion).not.toHaveBeenCalled();

        deps.isDjvuMode.value = false;
        exposed.handleCaptureRegion();
        expect(deps.handleCaptureRegion).toHaveBeenCalledOnce();
    });

    it('suppresses crop in DjVu mode', () => {
        const deps = createDeps({ isDjvuMode: ref(true) });
        const exposed = createWorkspaceExpose(deps);

        exposed.handleCrop();
        expect(deps.handleCrop).not.toHaveBeenCalled();

        deps.isDjvuMode.value = false;
        exposed.handleCrop();
        expect(deps.handleCrop).toHaveBeenCalledOnce();
    });

    it('delegates print through the exposed workspace command surface', async () => {
        const deps = createDeps();
        const exposed = createWorkspaceExpose(deps);

        await exposed.handlePrint();

        expect(deps.handlePrint).toHaveBeenCalledOnce();
    });

    it('includes print preparation state in the toolbar snapshot', () => {
        const deps = createDeps({
            isPreparingPrint: ref(true),
            isPreparingCurrentPagePrint: ref(true),
        });
        const exposed = createWorkspaceExpose(deps);

        expect(exposed.getToolbarSnapshot().isPreparingPrint).toBe(true);
        expect(exposed.getToolbarSnapshot().isPreparingCurrentPagePrint).toBe(true);
    });

    it('keeps toolbar current page owned by the reactive workspace authority', () => {
        const currentPage = ref(2);
        const documentViewerRef = ref<IWorkspaceDocumentViewerNavigationPort | null>({
            getCurrentPage: () => 8,
            scrollToPage: vi.fn(),
        });
        const deps = createDeps({
            currentPage,
            totalPages: ref(10),
            documentViewerRef,
        });
        const exposed = createWorkspaceExpose(deps);
        const snapshot = computed(exposed.getToolbarSnapshot);

        expect(snapshot.value.currentPage).toBe(2);

        currentPage.value = 6;

        expect(snapshot.value.currentPage).toBe(6);
    });

    it('keeps toolbar page and zoom metadata pending while the document visual is opening', () => {
        const documentViewerRef = ref<IWorkspaceDocumentViewerNavigationPort | null>({
            getCurrentPage: () => 99,
            scrollToPage: vi.fn(),
        });
        const deps = createDeps({
            hasPdf: ref(true),
            isOpeningDocument: ref(true),
            currentPage: ref(42),
            totalPages: ref(564),
            zoom: ref(2.38),
            effectiveZoom: ref(2.38),
            documentViewerRef,
        });
        const exposed = createWorkspaceExpose(deps);

        expect(exposed.getToolbarSnapshot()).toMatchObject({
            isOpeningDocument: true,
            currentPage: 1,
            totalPages: 0,
            zoom: 1,
            effectiveZoom: 1,
        });
    });

    it('delegates public automation methods through the narrow PDF automation port', async () => {
        const commentAtPoint = vi.fn(async () => true);
        const highlightSelection = vi.fn(async () => true);
        const shape = {
            id: 'shape-1',
            type: 'rectangle' as const,
            pageIndex: 0,
            x: 10,
            y: 20,
            width: 100,
            height: 50,
            color: '#ff0000',
            opacity: 1,
            strokeWidth: 2,
        };
        const pdfAutomationViewerRef = ref({
            commentAtPoint,
            getAllShapes: () => [shape],
            getDeletedEmbeddedShapeAnnotationIds: () => ['44R'],
            getDeletedEmbeddedShapeStableKeys: () => ['evb-shape:deleted'],
            highlightSelection,
        });
        const deps = createDeps({pdfAutomationViewerRef});
        const exposed = createWorkspaceExpose(deps);

        expect(exposed.getAllShapes?.()).toEqual([shape]);
        expect(exposed.getDeletedEmbeddedShapeAnnotationIds?.()).toEqual(['44R']);
        expect(exposed.getDeletedEmbeddedShapeStableKeys?.()).toEqual(['evb-shape:deleted']);
        await expect(exposed.highlightSelection?.()).resolves.toBe(true);
        await expect(
            exposed.commentAtPoint?.(1, 20, 30, {preferTextAnchor: true}),
        ).resolves.toBe(true);
        expect(highlightSelection).toHaveBeenCalledOnce();
        expect(commentAtPoint).toHaveBeenCalledWith(1, 20, 30, {preferTextAnchor: true});
    });
});
