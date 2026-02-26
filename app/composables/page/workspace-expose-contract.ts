import type { IWorkspaceExpose } from '@app/types/workspace-expose';

type TWorkspaceExposeMethod = keyof Omit<IWorkspaceExpose, 'hasPdf'>;

export const REQUIRED_WORKSPACE_EXPOSE_METHODS = [
    'handleSave',
    'handleSaveAs',
    'handleUndo',
    'handleRedo',
    'handleOpenFileFromUi',
    'handleOpenFileDirectWithPersist',
    'handleOpenFileDirectBatchWithPersist',
    'handleOpenFileWithResult',
    'handleCloseFileFromUi',
    'handleExportDocx',
    'handleExportImages',
    'handleExportMultiPageTiff',
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
    'handleDeletePages',
    'handleExtractPages',
    'handleRotateCw',
    'handleRotateCcw',
    'handleInsertPages',
    'handleConvertToPdf',
    'captureSplitPayload',
    'restoreSplitPayload',
    'closeAllDropdowns',
    'getToolbarSnapshot',
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
