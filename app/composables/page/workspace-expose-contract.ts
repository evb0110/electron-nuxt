import type { IWorkspaceExpose } from '@app/types/workspace-expose';

export const REQUIRED_WORKSPACE_EXPOSE_METHODS: Array<keyof Omit<IWorkspaceExpose, 'hasPdf'>> = [
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
];

export function isWorkspaceExpose(value: unknown): value is IWorkspaceExpose {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    if (!('hasPdf' in candidate)) {
        return false;
    }

    return REQUIRED_WORKSPACE_EXPOSE_METHODS.every(methodName => typeof candidate[methodName] === 'function');
}
