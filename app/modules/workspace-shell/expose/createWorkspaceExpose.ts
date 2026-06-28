import type {
    ComputedRef,
    Ref,
} from 'vue';
import { ZOOM } from '@app/constants/pdfLayout';
import type {
    IAnnotationCommentSummary,
    TAnnotationCommentsStatus,
} from '@app/types/annotations';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import type {
    IWorkspaceAgentPort,
    IWorkspaceExportPort,
    IWorkspaceExpose,
    IWorkspaceFilePort,
    IWorkspaceAutomationStateSnapshot,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import { clampPdfManualZoom } from '@app/modules/pdf-viewer/public';
import type { IAnnotationNoteWindowState } from '@app/types/annotationNoteWindow';
import type {
    IWorkspaceDocumentViewerNavigationPort,
    IWorkspacePdfViewerExposeAutomationPort,
    IWorkspacePdfViewerExposeToolbarSnapshotPort,
} from '@app/modules/workspace-shell/types/workspaceOrchestration.types';

interface ICreateWorkspaceExposeDeps extends
    IWorkspaceFilePort,
    IWorkspaceExportPort,
    IWorkspaceAgentPort {
    hasPdf: Ref<boolean>;
    isOpeningDocument: Ref<boolean>;
    hasOpenError: Ref<boolean>;
    isPreparingPrint: Ref<boolean>;
    isPreparingCurrentPagePrint: Ref<boolean>;
    canSave: Ref<boolean>;
    canUndo: Ref<boolean>;
    canRedo: Ref<boolean>;
    canExportDocx: Ref<boolean>;
    isSaving: Ref<boolean>;
    isSavingAs: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    isExportingDocx: Ref<boolean>;
    hasOpenAnnotationNotes?: Ref<boolean>;
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
    pdfToolbarSnapshotViewerRef?: Ref<IWorkspacePdfViewerExposeToolbarSnapshotPort | null>;
    pdfAutomationViewerRef?: Ref<IWorkspacePdfViewerExposeAutomationPort | null>;
    documentViewerRef?: Ref<IWorkspaceDocumentViewerNavigationPort | null>;
    handleFitMode: (mode: TFitMode) => void;
    handleGoToPage: (page: number) => void;
    handleToggleSidebar: () => void;
    handleToggleContinuousScroll: () => void;
    handleEnableDragMode: () => void;
    handleDisableDragMode: () => void;
    handleCaptureRegion: () => void;
    handleCrop: () => void;
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
    waitForDocumentOpenSettled: IWorkspaceExpose['waitForDocumentOpenSettled'];
    workingCopyPath: Ref<TDocumentRef | null>;
    originalPath: Ref<TDocumentRef | null>;
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    annotationCommentsStatus: Ref<TAnnotationCommentsStatus>;
    annotationDirty: Ref<boolean>;
    isDirty?: Ref<boolean>;
    hasAnnotationChanges?: () => boolean;
    hasLivePdfJsAnnotationChanges?: () => boolean;
    hasSavedPdfJsAnnotationBaselineChanges?: () => boolean;
    hasPreservedAnnotationSourceChanges?: () => boolean;
    hasPendingUnsavedChanges?: ComputedRef<boolean>;
    pendingEmbeddedAnnotationDeleteCount?: ComputedRef<number>;
    pageLabelsDirty?: Ref<boolean>;
    bookmarksDirty?: Ref<boolean>;
    sortedAnnotationNoteWindows: Ref<IAnnotationNoteWindowState[]>;
    handleOcrComplete: (payload: unknown) => Promise<void>;
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
    return clampPdfManualZoom(level);
}

/**
 * Builds the public workspace command surface exposed to parent tabs/menu bindings.
 * Keeping this mapping centralized avoids duplicating command wiring in component files.
 */
export function createWorkspaceExpose(deps: ICreateWorkspaceExposeDeps): IWorkspaceExpose {
    async function handleSaveFromCommandSurface() {
        const hasSaveableOpenNotes = deps.hasOpenAnnotationNotes?.value === true;
        if (
            !deps.hasPdf.value
            || (!deps.canSave.value && !hasSaveableOpenNotes)
            || deps.isAnySaving.value
            || deps.isHistoryBusy.value
            || deps.isDjvuMode.value
        ) {
            return false;
        }

        return deps.handleSave();
    }

    async function handleRepairSaveFromCommandSurface() {
        if (
            !deps.hasPdf.value
            || deps.isOpeningDocument.value
            || deps.hasOpenError.value
            || deps.isAnySaving.value
            || deps.isHistoryBusy.value
            || deps.isDjvuMode.value
        ) {
            return false;
        }

        return deps.handleRepairSave();
    }

    async function handleOptimizePdfForInteractionFromCommandSurface() {
        if (
            !deps.hasPdf.value
            || deps.isOpeningDocument.value
            || deps.hasOpenError.value
            || deps.isAnySaving.value
            || deps.isHistoryBusy.value
            || deps.isDjvuMode.value
        ) {
            return false;
        }

        return deps.handleOptimizePdfForInteraction();
    }

    function getToolbarSnapshot(): IWorkspaceToolbarSnapshot {
        const currentPage = normalizeToolbarSnapshotPage(
            deps.documentViewerRef?.value?.getCurrentPage?.()
                ?? deps.pdfToolbarSnapshotViewerRef?.value?.getCurrentPage?.()
                ?? deps.currentPage.value,
        );
        const totalPages = normalizeToolbarSnapshotTotalPages(deps.totalPages.value, currentPage);
        return {
            hasPdf: deps.hasPdf.value,
            isOpeningDocument: deps.isOpeningDocument.value,
            hasOpenError: deps.hasOpenError.value,
            isPreparingPrint: deps.isPreparingPrint.value,
            isPreparingCurrentPagePrint: deps.isPreparingCurrentPagePrint.value,
            canSave: deps.canSave.value,
            canRepairSave: deps.hasPdf.value
                && !deps.isOpeningDocument.value
                && !deps.hasOpenError.value
                && !deps.isAnySaving.value
                && !deps.isHistoryBusy.value
                && !deps.isDjvuMode.value,
            canOptimizePdf: deps.hasPdf.value
                && !deps.isOpeningDocument.value
                && !deps.hasOpenError.value
                && !deps.isAnySaving.value
                && !deps.isHistoryBusy.value
                && !deps.isDjvuMode.value,
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
    }

    function resolveDisplayZoom() {
        if (Number.isFinite(deps.effectiveZoom.value) && deps.effectiveZoom.value > 0) {
            return deps.effectiveZoom.value;
        }
        return clampZoomLevel(deps.zoom.value);
    }

    function setCustomZoomFromDisplay(displayZoom: number) {
        const targetDisplayZoom = clampZoomLevel(displayZoom);
        deps.zoom.value = targetDisplayZoom;
        deps.effectiveZoom.value = targetDisplayZoom;
        deps.zoomMode.value = 'custom';
    }

    function getAutomationStateSnapshot(): IWorkspaceAutomationStateSnapshot {
        return {
            annotationComments: [...deps.annotationComments.value],
            annotationCommentsStatus: deps.annotationCommentsStatus.value,
            annotationDirty: deps.annotationDirty.value,
            dirtyState: {
                annotationDirty: deps.annotationDirty.value,
                bookmarksDirty: deps.bookmarksDirty?.value ?? false,
                fileDirty: deps.isDirty?.value ?? false,
                hasAnnotationChanges: deps.hasAnnotationChanges?.() ?? false,
                hasLivePdfJsAnnotationChanges: deps.hasLivePdfJsAnnotationChanges?.() ?? false,
                hasPendingUnsavedChanges: deps.hasPendingUnsavedChanges?.value ?? false,
                hasPreservedAnnotationSourceChanges: deps.hasPreservedAnnotationSourceChanges?.() ?? false,
                hasSavedPdfJsAnnotationBaselineChanges: deps.hasSavedPdfJsAnnotationBaselineChanges?.() ?? false,
                pageLabelsDirty: deps.pageLabelsDirty?.value ?? false,
                pendingEmbeddedAnnotationDeleteCount: deps.pendingEmbeddedAnnotationDeleteCount?.value ?? 0,
            },
            originalPath: deps.originalPath.value,
            sortedAnnotationNoteWindows: deps.sortedAnnotationNoteWindows.value.map(note => ({
                ...note,
                comment: {...note.comment},
            })),
            workingCopyPath: deps.workingCopyPath.value,
        };
    }

    return {
        handleSave: handleSaveFromCommandSurface,
        handleRepairSave: handleRepairSaveFromCommandSurface,
        handleOptimizePdfForInteraction: handleOptimizePdfForInteractionFromCommandSurface,
        handleSaveAs: deps.handleSaveAs,
        handlePrint: deps.handlePrint,
        handlePrintCurrentPage: deps.handlePrintCurrentPage,
        handleUndo: deps.handleUndo,
        handleRedo: deps.handleRedo,
        handleOpenFileFromUi: deps.handleOpenFileFromUi,
        handleCombineImages: deps.handleCombineImages,
        handleOpenFileDirectWithPersist: deps.handleOpenFileDirectWithPersist,
        handleOpenFileDirectBatchWithPersist: deps.handleOpenFileDirectBatchWithPersist,
        handleOpenFileWithResult: deps.handleOpenFileWithResult,
        handleCloseFileFromUi: deps.handleCloseFileFromUi,
        openRecentFile: deps.openRecentFile,
        handleExportDocx: deps.handleExportDocx,
        handleExportImages: deps.handleExportImages,
        handleExportMultiPageTiff: deps.handleExportMultiPageTiff,
        hasPdf: deps.hasPdf,
        handleZoomIn: () => {
            setCustomZoomFromDisplay(resolveDisplayZoom() + ZOOM.STEP);
        },
        handleZoomOut: () => {
            const displayZoom = resolveDisplayZoom();
            if (displayZoom <= ZOOM.MIN) {
                return;
            }
            setCustomZoomFromDisplay(displayZoom - ZOOM.STEP);
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
        handleGoToPage: deps.handleGoToPage,
        handleToggleSidebar: deps.handleToggleSidebar,
        handleToggleContinuousScroll: deps.handleToggleContinuousScroll,
        handleEnableDragMode: deps.handleEnableDragMode,
        handleDisableDragMode: deps.handleDisableDragMode,
        handleCaptureRegion: () => {
            if (deps.isDjvuMode.value) {
                return;
            }
            deps.handleCaptureRegion();
        },
        handleCrop: () => {
            if (deps.isDjvuMode.value) {
                return;
            }
            deps.handleCrop();
        },
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
        waitForDocumentOpenSettled: deps.waitForDocumentOpenSettled,
        runAgentAction: deps.runAgentAction,
        readAgentResource: deps.readAgentResource,
        closeAllDropdowns: deps.closeAllDropdowns,
        getToolbarSnapshot,
        getAutomationStateSnapshot,
        handleOcrComplete: deps.handleOcrComplete,
        scrollToPage: (page: number) => {
            deps.documentViewerRef?.value?.scrollToPage(page);
        },
        getAllShapes: () => deps.pdfAutomationViewerRef?.value?.getAllShapes?.() ?? [],
        getDeletedEmbeddedShapeAnnotationIds: () => deps.pdfAutomationViewerRef?.value?.getDeletedEmbeddedShapeAnnotationIds?.() ?? [],
        getDeletedEmbeddedShapeStableKeys: () => deps.pdfAutomationViewerRef?.value?.getDeletedEmbeddedShapeStableKeys?.() ?? [],
        highlightSelection: () => deps.pdfAutomationViewerRef?.value?.highlightSelection?.() ?? Promise.resolve(false),
        commentAtPoint: (pageNumber, pageX, pageY, options) => (
            deps.pdfAutomationViewerRef?.value?.commentAtPoint?.(pageNumber, pageX, pageY, options) ?? Promise.resolve(false)
        ),
    };
}
