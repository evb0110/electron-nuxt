import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TSplitPayload } from '@contracts/windowTabs';
import type {
    IAnnotationCommentSummary,
    TAnnotationCommentsStatus,
} from '@app/types/annotations';
import type { IAnnotationNoteWindowState } from '@app/utils/pdf-viewer/annotations/annotationNoteWindowTypes';
import type {
    IRecentFile,
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';

export interface IWorkspaceToolbarSnapshot {
    hasPdf: boolean;
    isOpeningDocument: boolean;
    hasOpenError: boolean;
    isPreparingPrint: boolean;
    isPreparingCurrentPagePrint: boolean;
    canSave: boolean;
    canRepairSave: boolean;
    canUndo: boolean;
    canRedo: boolean;
    canExportDocx: boolean;
    isSaving: boolean;
    isSavingAs: boolean;
    isAnySaving: boolean;
    isHistoryBusy: boolean;
    isExportingDocx: boolean;
    isFitWidthActive: boolean;
    isFitHeightActive: boolean;
    showSidebar: boolean;
    dragMode: boolean;
    continuousScroll: boolean;
    isDjvuMode: boolean;
    isCapturingRegion: boolean;
    isCropSelecting: boolean;
    isPlacingPageNote: boolean;
    zoom: number;
    effectiveZoom: number;
    zoomMode: TZoomMode;
    fitMode: TFitMode;
    viewMode: TPdfViewMode;
    currentPage: number;
    totalPages: number;
}

export function createDefaultWorkspaceToolbarSnapshot(): IWorkspaceToolbarSnapshot {
    return {
        hasPdf: false,
        isOpeningDocument: false,
        hasOpenError: false,
        isPreparingPrint: false,
        isPreparingCurrentPagePrint: false,
        canSave: false,
        canRepairSave: false,
        canUndo: false,
        canRedo: false,
        canExportDocx: false,
        isSaving: false,
        isSavingAs: false,
        isAnySaving: false,
        isHistoryBusy: false,
        isExportingDocx: false,
        isFitWidthActive: false,
        isFitHeightActive: false,
        showSidebar: false,
        dragMode: false,
        continuousScroll: false,
        isDjvuMode: false,
        isCapturingRegion: false,
        isCropSelecting: false,
        isPlacingPageNote: false,
        zoom: 1,
        effectiveZoom: 1,
        zoomMode: 'fit-width',
        fitMode: 'width',
        viewMode: 'single',
        currentPage: 1,
        totalPages: 0,
    };
}

export interface ICloseFileFromUiOptions {persist?: boolean;}

export interface IWorkspaceFilePort {
    handleSave: () => Promise<boolean>;
    handleRepairSave: () => Promise<boolean>;
    handleSaveAs: () => Promise<boolean>;
    handlePrint: () => void | Promise<void>;
    handlePrintCurrentPage: () => void | Promise<void>;
    handleUndo: () => void;
    handleRedo: () => void;
    handleOpenFileFromUi: () => Promise<boolean>;
    handleCombineImages: () => Promise<boolean>;
    handleOpenFileDirectWithPersist: (path: TDocumentRef) => Promise<boolean>;
    handleOpenFileDirectBatchWithPersist: (paths: TDocumentRef[]) => Promise<boolean>;
    handleOpenFileWithResult: (result: TOpenFileResult) => Promise<boolean>;
    handleCloseFileFromUi: (options?: ICloseFileFromUiOptions) => Promise<boolean>;
    openRecentFile: (file: IRecentFile) => Promise<boolean>;
}

export interface IWorkspaceExportPort {
    handleExportDocx: () => Promise<void>;
    handleExportImages: () => Promise<void>;
    handleExportMultiPageTiff: () => Promise<void>;
}

export interface IWorkspaceViewPort {
    handleZoomIn: () => void;
    handleZoomOut: () => void;
    handleFitWidth: () => void;
    handleFitHeight: () => void;
    handleActualSize: () => void;
    handleGoToPage: (page: number) => void;
    handleToggleSidebar: () => void;
    handleToggleContinuousScroll: () => void;
    handleEnableDragMode: () => void;
    handleDisableDragMode: () => void;
    handleCaptureRegion: () => void;
    handleQuickNote: () => void;
    handleInsertImageFromFile: () => Promise<void>;
    handlePasteImageFromClipboard: () => Promise<void>;
    handleViewModeSingle: () => void;
    handleViewModeFacing: () => void;
    handleViewModeFacingFirstSingle: () => void;
}

export interface IWorkspacePageOpsPort {
    handleDeletePages: () => void;
    handleExtractPages: () => void;
    handleRotateCw: () => void;
    handleRotateCcw: () => void;
    handleInsertPages: () => void;
    handleConvertToPdf: () => void;
}

export interface IWorkspaceSplitTransferPort {
    captureSplitPayload: () => Promise<TSplitPayload>;
    restoreSplitPayload: (payload: TSplitPayload) => Promise<void>;
}

export interface IWorkspaceUiPort {
    closeAllDropdowns: () => void;
    getToolbarSnapshot: () => IWorkspaceToolbarSnapshot;
    waitForDocumentOpenSettled: () => Promise<void>;
}

export interface IWorkspaceAgentPort {
    runAgentAction: (
        actionId: string,
        input?: Record<string, unknown>,
        options?: {dryRun?: boolean},
    ) => Promise<Record<string, unknown>>;
    readAgentResource: (uri: string) => Promise<Record<string, unknown>>;
}

interface IWorkspaceStatePort {hasPdf: {value: boolean;} | boolean;}

export interface IWorkspaceAutomationStateSnapshot {
    annotationComments: IAnnotationCommentSummary[];
    annotationCommentsStatus: TAnnotationCommentsStatus;
    annotationDirty: boolean;
    originalPath: TDocumentRef | null;
    sortedAnnotationNoteWindows: IAnnotationNoteWindowState[];
    workingCopyPath: TDocumentRef | null;
}

export interface IWorkspaceAutomationPort {
    commentAtPoint?: (
        pageNumber: number,
        pageX: number,
        pageY: number,
        options?: { preferTextAnchor?: boolean },
    ) => Promise<boolean>;
    getAllShapes?: () => unknown[];
    getAutomationStateSnapshot: () => IWorkspaceAutomationStateSnapshot;
    getDeletedEmbeddedShapeAnnotationIds?: () => string[];
    getDeletedEmbeddedShapeStableKeys?: () => string[];
    handleOcrComplete?: (payload: unknown) => Promise<void>;
    highlightSelection?: () => Promise<boolean>;
    scrollToPage?: (page: number) => void;
}

export interface IWorkspaceExpose extends
    IWorkspaceFilePort,
    IWorkspaceExportPort,
    IWorkspaceViewPort,
    IWorkspacePageOpsPort,
    IWorkspaceSplitTransferPort,
    IWorkspaceUiPort,
    IWorkspaceAgentPort,
    IWorkspaceAutomationPort,
    IWorkspaceStatePort {}
