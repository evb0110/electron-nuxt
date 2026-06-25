import type {
    IWorkspaceAgentPort,
    IWorkspaceAutomationPort,
    IWorkspaceExportPort,
    IWorkspaceExpose,
    IWorkspaceFilePort,
    IWorkspacePageOpsPort,
    IWorkspaceSplitTransferPort,
    IWorkspaceUiPort,
    IWorkspaceViewPort,
} from '@app/types/workspaceExpose';

export type TWorkspaceExposeMethod = keyof Omit<IWorkspaceExpose, 'hasPdf'>;

interface IWorkspaceExposeMethodDescriptorMap {
    readonly file: ReadonlyArray<keyof IWorkspaceFilePort>;
    readonly export: ReadonlyArray<keyof IWorkspaceExportPort>;
    readonly view: ReadonlyArray<keyof IWorkspaceViewPort>;
    readonly pageOps: ReadonlyArray<keyof IWorkspacePageOpsPort>;
    readonly splitTransfer: ReadonlyArray<keyof IWorkspaceSplitTransferPort>;
    readonly ui: ReadonlyArray<keyof IWorkspaceUiPort>;
    readonly agent: ReadonlyArray<keyof IWorkspaceAgentPort>;
    readonly automation: ReadonlyArray<keyof IWorkspaceAutomationPort>;
}

export const workspaceExposeMethodDescriptors = {
    file: [
        'handleSave',
        'handleRepairSave',
        'handleOptimizePdfForInteraction',
        'handleSaveAs',
        'handlePrint',
        'handlePrintCurrentPage',
        'handleUndo',
        'handleRedo',
        'handleOpenFileFromUi',
        'handleCombineImages',
        'handleOpenFileDirectWithPersist',
        'handleOpenFileDirectBatchWithPersist',
        'handleOpenFileWithResult',
        'handleCloseFileFromUi',
        'openRecentFile',
    ],
    export: [
        'handleExportDocx',
        'handleExportImages',
        'handleExportMultiPageTiff',
    ],
    view: [
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
        'handleCrop',
        'handleQuickNote',
        'handleInsertImageFromFile',
        'handlePasteImageFromClipboard',
        'handleViewModeSingle',
        'handleViewModeFacing',
        'handleViewModeFacingFirstSingle',
    ],
    pageOps: [
        'handleDeletePages',
        'handleExtractPages',
        'handleRotateCw',
        'handleRotateCcw',
        'handleInsertPages',
        'handleConvertToPdf',
    ],
    splitTransfer: [
        'captureSplitPayload',
        'restoreSplitPayload',
    ],
    ui: [
        'closeAllDropdowns',
        'getToolbarSnapshot',
        'waitForDocumentOpenSettled',
    ],
    agent: [
        'runAgentAction',
        'readAgentResource',
    ],
    automation: [
        'commentAtPoint',
        'getAllShapes',
        'getAutomationStateSnapshot',
        'getDeletedEmbeddedShapeAnnotationIds',
        'getDeletedEmbeddedShapeStableKeys',
        'handleOcrComplete',
        'highlightSelection',
        'scrollToPage',
    ],
} as const satisfies IWorkspaceExposeMethodDescriptorMap;

export const workspaceExposeRequiredMethodNames = [
    ...workspaceExposeMethodDescriptors.file,
    ...workspaceExposeMethodDescriptors.export,
    ...workspaceExposeMethodDescriptors.view,
    ...workspaceExposeMethodDescriptors.pageOps,
    ...workspaceExposeMethodDescriptors.splitTransfer,
    ...workspaceExposeMethodDescriptors.ui,
    ...workspaceExposeMethodDescriptors.agent,
    ...workspaceExposeMethodDescriptors.automation,
] as const satisfies readonly TWorkspaceExposeMethod[];
