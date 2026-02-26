import type { TOpenFileResult } from '@app/types/electron-api';
import type { TSplitPayload } from '@app/types/split-payload';
import type {
    TFitMode,
    TPdfViewMode,
} from '@app/types/shared';

export interface IWorkspaceToolbarSnapshot {
    hasPdf: boolean;
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
    isPlacingPageNote: boolean;
    zoom: number;
    fitMode: TFitMode;
    viewMode: TPdfViewMode;
    currentPage: number;
    totalPages: number;
}

export interface ICloseFileFromUiOptions {persist?: boolean;}

export interface IWorkspaceExpose {
    handleSave: () => Promise<void>;
    handleSaveAs: () => Promise<void>;
    handleUndo: () => void;
    handleRedo: () => void;
    handleOpenFileFromUi: () => Promise<void>;
    handleOpenFileDirectWithPersist: (path: string) => Promise<void>;
    handleOpenFileDirectBatchWithPersist: (paths: string[]) => Promise<void>;
    handleOpenFileWithResult: (result: TOpenFileResult) => Promise<void>;
    handleCloseFileFromUi: (options?: ICloseFileFromUiOptions) => Promise<void>;
    handleExportDocx: () => Promise<void>;
    handleExportImages: () => Promise<void>;
    handleExportMultiPageTiff: () => Promise<void>;
    hasPdf: { value: boolean } | boolean;
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
    handleViewModeSingle: () => void;
    handleViewModeFacing: () => void;
    handleViewModeFacingFirstSingle: () => void;
    handleDeletePages: () => void;
    handleExtractPages: () => void;
    handleRotateCw: () => void;
    handleRotateCcw: () => void;
    handleInsertPages: () => void;
    handleConvertToPdf: () => void;
    captureSplitPayload: () => Promise<TSplitPayload>;
    restoreSplitPayload: (payload: TSplitPayload) => Promise<void>;
    closeAllDropdowns: () => void;
    getToolbarSnapshot: () => IWorkspaceToolbarSnapshot;
}
