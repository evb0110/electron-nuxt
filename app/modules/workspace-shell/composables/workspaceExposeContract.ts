import type {
    IWorkspaceExpose,
    IWorkspaceExportPort,
    IWorkspaceFilePort,
    IWorkspacePageOpsPort,
    IWorkspaceSplitTransferPort,
    IWorkspaceUiPort,
    IWorkspaceViewPort,
} from '@app/types/workspaceExpose';

const FILE_PORT_METHODS = [
    'handleSave',
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

type TWorkspaceExposeMethod = keyof Omit<IWorkspaceExpose, 'hasPdf'>;

export const REQUIRED_WORKSPACE_EXPOSE_METHODS = [
    ...FILE_PORT_METHODS,
    ...EXPORT_PORT_METHODS,
    ...VIEW_PORT_METHODS,
    ...PAGE_OPS_METHODS,
    ...SPLIT_TRANSFER_METHODS,
    ...UI_METHODS,
] as const satisfies readonly TWorkspaceExposeMethod[];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isHasPdfField(value: unknown): value is IWorkspaceExpose['hasPdf'] {
    if (typeof value === 'boolean') {
        return true;
    }
    return isRecord(value) && typeof value.value === 'boolean';
}

export function isWorkspaceExpose(value: unknown): value is IWorkspaceExpose {
    if (!isRecord(value)) {
        return false;
    }

    if (!isHasPdfField(value.hasPdf)) {
        return false;
    }

    return REQUIRED_WORKSPACE_EXPOSE_METHODS.every(methodName => typeof value[methodName] === 'function');
}
