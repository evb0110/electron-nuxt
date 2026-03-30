import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platform-api';
import type { TSplitPayload } from '@contracts/window-tabs';
import type {
    TFitMode,
    TZoomMode,
    TPdfViewMode,
} from '@contracts/shared';

export interface IWorkspaceToolbarSnapshot {
    hasPdf: boolean;
    isOpeningDocument: boolean;
    canSave: boolean;
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

export interface ICloseFileFromUiOptions {persist?: boolean;}

export interface IWorkspaceFilePort {
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
}

interface IWorkspaceStatePort {hasPdf: {value: boolean;} | boolean;}

export interface IWorkspaceExpose extends
    IWorkspaceFilePort,
    IWorkspaceExportPort,
    IWorkspaceViewPort,
    IWorkspacePageOpsPort,
    IWorkspaceSplitTransferPort,
    IWorkspaceUiPort,
    IWorkspaceStatePort {}
