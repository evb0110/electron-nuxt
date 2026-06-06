import type {
    IWorkspaceAgentPort,
    IWorkspaceExportPort,
    IWorkspaceExpose,
    IWorkspaceFilePort,
    IWorkspacePageOpsPort,
    IWorkspaceSplitTransferPort,
    IWorkspaceUiPort,
    IWorkspaceViewPort,
} from '@app/types/workspaceExpose';

const FILE_PORT_METHODS = [
    'handleSave',
    'handleRepairSave',
    'handleSaveAs',
    'handlePrint',
    'handleUndo',
    'handleRedo',
    'handleOpenFileFromUi',
    'handleCombineImages',
    'handleOpenFileDirectWithPersist',
    'handleOpenFileDirectBatchWithPersist',
    'handleOpenFileWithResult',
    'handleCloseFileFromUi',
    'openRecentFile',
] as const satisfies ReadonlyArray<keyof IWorkspaceFilePort>;

const EXPORT_PORT_METHODS = [
    'handleExportDocx',
    'handleExportImages',
    'handleExportMultiPageTiff',
] as const satisfies ReadonlyArray<keyof IWorkspaceExportPort>;

const VIEW_PORT_METHODS = [
    'handleZoomIn',
    'handleZoomOut',
    'handleFitWidth',
    'handleFitHeight',
    'handleActualSize',
    'handleGoToPage',
    'handleToggleSidebar',
    'handleToggleContinuousScroll',
    'handleEnableDragMode',
    'handleDisableDragMode',
    'handleCaptureRegion',
    'handleQuickNote',
    'handleViewModeSingle',
    'handleViewModeFacing',
    'handleViewModeFacingFirstSingle',
] as const satisfies ReadonlyArray<keyof IWorkspaceViewPort>;

const PAGE_OPS_METHODS = [
    'handleDeletePages',
    'handleExtractPages',
    'handleRotateCw',
    'handleRotateCcw',
    'handleInsertPages',
    'handleConvertToPdf',
] as const satisfies ReadonlyArray<keyof IWorkspacePageOpsPort>;

const SPLIT_TRANSFER_METHODS = [
    'captureSplitPayload',
    'restoreSplitPayload',
] as const satisfies ReadonlyArray<keyof IWorkspaceSplitTransferPort>;

const UI_METHODS = [
    'closeAllDropdowns',
    'getToolbarSnapshot',
    'waitForDocumentOpenSettled',
] as const satisfies ReadonlyArray<keyof IWorkspaceUiPort>;

const AGENT_METHODS = [
    'runAgentAction',
    'readAgentResource',
] as const satisfies ReadonlyArray<keyof IWorkspaceAgentPort>;

type TWorkspaceExposeMethod = keyof Omit<IWorkspaceExpose, 'hasPdf'>;

export const requiredWorkspaceExposeMethods = [
    ...FILE_PORT_METHODS,
    ...EXPORT_PORT_METHODS,
    ...VIEW_PORT_METHODS,
    ...PAGE_OPS_METHODS,
    ...SPLIT_TRANSFER_METHODS,
    ...UI_METHODS,
    ...AGENT_METHODS,
] as const satisfies readonly TWorkspaceExposeMethod[];
