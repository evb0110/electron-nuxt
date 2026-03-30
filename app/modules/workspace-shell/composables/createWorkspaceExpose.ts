import type { Ref } from 'vue';
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platform-api';
import { ZOOM } from '@app/constants/pdf-layout';
import type {
    TFitMode,
    TZoomMode,
    TPdfViewMode,
} from '@contracts/shared';
import type {
    ICloseFileFromUiOptions,
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspace-expose';

interface ICreateWorkspaceExposeDeps {
    handleSave: () => Promise<void>;
    handleSaveAs: () => Promise<void>;
    handleUndo: () => void;
    handleRedo: () => void;
    handleOpenFileFromUi: () => Promise<void>;
    handleCombineImages: () => Promise<void>;
    handleOpenFileDirectWithPersist: (path: TDocumentRef) => Promise<void>;
    handleOpenFileDirectBatchWithPersist: (paths: TDocumentRef[]) => Promise<void>;
    handleOpenFileWithResult: (result: TOpenFileResult) => Promise<void>;
    handleCloseFileFromUi: (options?: ICloseFileFromUiOptions) => Promise<void>;
    handleExportDocx: () => Promise<void>;
    handleExportImages: () => Promise<void>;
    handleExportMultiPageTiff: () => Promise<void>;
    hasPdf: Ref<boolean>;
    isOpeningDocument: Ref<boolean>;
    canSave: Ref<boolean>;
    canUndo: Ref<boolean>;
    canRedo: Ref<boolean>;
    canExportDocx: Ref<boolean>;
    isSaving: Ref<boolean>;
    isSavingAs: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    isExportingDocx: Ref<boolean>;
    isFitWidthActive: Ref<boolean>;
    isFitHeightActive: Ref<boolean>;
    showSidebar: Ref<boolean>;
    dragMode: Ref<boolean>;
    continuousScroll: Ref<boolean>;
    isCapturingRegion: Ref<boolean>;
    isCropSelecting: Ref<boolean>;
    isPlacingPageNote: Ref<boolean>;
    closeAllDropdowns: () => void;
    zoom: Ref<number>;
    effectiveZoom: Ref<number>;
    zoomMode: Ref<TZoomMode>;
    fitMode: Ref<TFitMode>;
    viewMode: Ref<TPdfViewMode>;
    currentPage: Ref<number>;
    handleFitMode: (mode: TFitMode) => void;
    handleToggleSidebar: () => void;
    handleToggleContinuousScroll: () => void;
    handleEnableDragMode: () => void;
    handleDisableDragMode: () => void;
    handleCaptureRegion: () => void;
    handleQuickNote: () => void;
    handleInsertImageFromFile: () => Promise<void>;
    handlePasteImageFromClipboard: () => Promise<void>;
    selectedThumbnailPages: Ref<number[]>;
    pageOpsDelete: (pages: number[], totalPages: number) => Promise<boolean>;
    pageOpsExtract: (pages: number[]) => Promise<boolean>;
    handlePageRotate: (pages: number[], angle: 90 | 270) => Promise<boolean>;
    pageOpsInsert: (totalPages: number, afterPage: number) => Promise<boolean>;
    totalPages: Ref<number>;
    isDjvuMode: Ref<boolean>;
    openConvertDialog: () => void;
    captureSplitPayload: IWorkspaceExpose['captureSplitPayload'];
    restoreSplitPayload: IWorkspaceExpose['restoreSplitPayload'];
}

function getSelectedPages(selectedThumbnailPages: Ref<number[]>) {
    return selectedThumbnailPages.value;
}

function normalizeToolbarSnapshotPage(page: number | undefined) {
    if (typeof page !== 'number' || !Number.isFinite(page)) {
        return 1;
    }
    return Math.max(1, Math.floor(page));
}

function normalizeToolbarSnapshotTotalPages(totalPages: number | undefined, fallbackPage: number) {
    if (typeof totalPages !== 'number' || !Number.isFinite(totalPages)) {
        return fallbackPage;
    }
    return Math.max(fallbackPage, Math.floor(totalPages));
}

function clampZoomLevel(level: number) {
    if (!Number.isFinite(level)) {
        return 1;
    }
    return Math.min(ZOOM.MAX, Math.max(ZOOM.MIN, level));
}

/**
 * Builds the public workspace command surface exposed to parent tabs/menu bindings.
 * Keeping this mapping centralized avoids duplicating command wiring in component files.
 */
export function createWorkspaceExpose(deps: ICreateWorkspaceExposeDeps): IWorkspaceExpose {
    const getToolbarSnapshot = (): IWorkspaceToolbarSnapshot => {
        const currentPage = normalizeToolbarSnapshotPage(deps.currentPage.value);
        const totalPages = normalizeToolbarSnapshotTotalPages(deps.totalPages.value, currentPage);
        return {
            hasPdf: deps.hasPdf.value,
            isOpeningDocument: deps.isOpeningDocument.value,
            canSave: deps.canSave.value,
            canUndo: deps.canUndo.value,
            canRedo: deps.canRedo.value,
            canExportDocx: deps.canExportDocx.value,
            isSaving: deps.isSaving.value,
            isSavingAs: deps.isSavingAs.value,
            isAnySaving: deps.isAnySaving.value,
            isHistoryBusy: deps.isHistoryBusy.value,
            isExportingDocx: deps.isExportingDocx.value,
            isFitWidthActive: deps.isFitWidthActive.value,
            isFitHeightActive: deps.isFitHeightActive.value,
            showSidebar: deps.showSidebar.value,
            dragMode: deps.dragMode.value,
            continuousScroll: deps.continuousScroll.value,
            isDjvuMode: deps.isDjvuMode.value,
            isCapturingRegion: deps.isCapturingRegion.value,
            isCropSelecting: deps.isCropSelecting.value,
            isPlacingPageNote: deps.isPlacingPageNote.value,
            zoom: deps.zoom.value,
            effectiveZoom: deps.effectiveZoom.value,
            zoomMode: deps.zoomMode.value,
            fitMode: deps.fitMode.value,
            viewMode: deps.viewMode.value,
            currentPage,
            totalPages,
        };
    };

    function resolveDisplayZoom() {
        if (Number.isFinite(deps.effectiveZoom.value) && deps.effectiveZoom.value > 0) {
            return deps.effectiveZoom.value;
        }
        return clampZoomLevel(deps.zoom.value);
    }

    function resolveBaselineScale() {
        const multiplier = deps.zoom.value;
        const displayZoom = resolveDisplayZoom();
        if (!Number.isFinite(multiplier) || Math.abs(multiplier) < 0.0001) {
            return 1;
        }
        const baseline = displayZoom / multiplier;
        if (!Number.isFinite(baseline) || baseline <= 0) {
            return 1;
        }
        return baseline;
    }

    function setCustomZoomFromDisplay(displayZoom: number) {
        const targetDisplayZoom = clampZoomLevel(displayZoom);
        const baselineScale = resolveBaselineScale();
        deps.zoom.value = clampZoomLevel(targetDisplayZoom / baselineScale);
        deps.effectiveZoom.value = targetDisplayZoom;
        deps.zoomMode.value = 'custom';
    }

    return {
        handleSave: deps.handleSave,
        handleSaveAs: deps.handleSaveAs,
        handleUndo: deps.handleUndo,
        handleRedo: deps.handleRedo,
        handleOpenFileFromUi: deps.handleOpenFileFromUi,
        handleCombineImages: deps.handleCombineImages,
        handleOpenFileDirectWithPersist: deps.handleOpenFileDirectWithPersist,
        handleOpenFileDirectBatchWithPersist: deps.handleOpenFileDirectBatchWithPersist,
        handleOpenFileWithResult: deps.handleOpenFileWithResult,
        handleCloseFileFromUi: deps.handleCloseFileFromUi,
        handleExportDocx: deps.handleExportDocx,
        handleExportImages: deps.handleExportImages,
        handleExportMultiPageTiff: deps.handleExportMultiPageTiff,
        hasPdf: deps.hasPdf,
        handleZoomIn: () => {
            setCustomZoomFromDisplay(resolveDisplayZoom() + ZOOM.STEP);
        },
        handleZoomOut: () => {
            setCustomZoomFromDisplay(resolveDisplayZoom() - ZOOM.STEP);
        },
        handleFitWidth: () => {
            deps.handleFitMode('width');
        },
        handleFitHeight: () => {
            deps.handleFitMode('height');
        },
        handleActualSize: () => {
            setCustomZoomFromDisplay(1);
        },
        handleToggleSidebar: deps.handleToggleSidebar,
        handleToggleContinuousScroll: deps.handleToggleContinuousScroll,
        handleEnableDragMode: deps.handleEnableDragMode,
        handleDisableDragMode: deps.handleDisableDragMode,
        handleCaptureRegion: deps.handleCaptureRegion,
        handleQuickNote: deps.handleQuickNote,
        handleInsertImageFromFile: deps.handleInsertImageFromFile,
        handlePasteImageFromClipboard: deps.handlePasteImageFromClipboard,
        handleViewModeSingle: () => {
            deps.viewMode.value = 'single';
        },
        handleViewModeFacing: () => {
            deps.viewMode.value = 'facing';
        },
        handleViewModeFacingFirstSingle: () => {
            deps.viewMode.value = 'facing-first-single';
        },
        handleDeletePages: () => {
            const pages = getSelectedPages(deps.selectedThumbnailPages);
            if (pages.length > 0) {
                void deps.pageOpsDelete(pages, deps.totalPages.value);
            }
        },
        handleExtractPages: () => {
            const pages = getSelectedPages(deps.selectedThumbnailPages);
            if (pages.length > 0) {
                void deps.pageOpsExtract(pages);
            }
        },
        handleRotateCw: () => {
            const pages = getSelectedPages(deps.selectedThumbnailPages);
            if (pages.length > 0) {
                void deps.handlePageRotate(pages, 90);
            }
        },
        handleRotateCcw: () => {
            const pages = getSelectedPages(deps.selectedThumbnailPages);
            if (pages.length > 0) {
                void deps.handlePageRotate(pages, 270);
            }
        },
        handleInsertPages: () => {
            void deps.pageOpsInsert(deps.totalPages.value, deps.totalPages.value);
        },
        handleConvertToPdf: () => {
            if (deps.isDjvuMode.value) {
                deps.openConvertDialog();
                return;
            }
            void deps.handleOpenFileFromUi();
        },
        captureSplitPayload: deps.captureSplitPayload,
        restoreSplitPayload: deps.restoreSplitPayload,
        closeAllDropdowns: deps.closeAllDropdowns,
        getToolbarSnapshot,
    };
}
