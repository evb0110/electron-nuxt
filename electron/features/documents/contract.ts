import type {IDocumentRevisionChangedEvent} from '@contracts/documentRevision';
import type {
    IDocumentsFileCapability,
    IDocumentsMenuCapability,
    IPdfNativePagePreviewOptions,
    IPdfSaveAsOptions,
    IPdfOptimizeOptions,
    IPdfOptimizeProgress,
    TOpenBatchProgressOperation,
    TOpenDocumentDirectBatchProgress,
} from '@contracts/electronApiDocuments';
import type {
    IBeginSerializedPdfPersistenceResult,
    IBeginSerializedPdfSaveAsResult,
} from '@electron/features/documents/serializedPdfPersistenceContract';
import type { ICreatePdfFromInputPathsProgress } from '@electron/image/pdfConversion';

export const DOCUMENTS_CHANNELS = {
    openDocumentDialog: 'dialog:openPdf',
    openPdfDialog: 'dialog:openPdf',
    openCombineDialog: 'dialog:openCombine',
    openFolderDialog: 'dialog:openFolder',
    openImageDialog: 'dialog:openImage',
    openDocumentDirect: 'dialog:openPdfDirect',
    openPdfDirect: 'dialog:openPdfDirect',
    openDocumentDirectBatch: 'dialog:openPdfDirectBatch',
    openPdfDirectBatch: 'dialog:openPdfDirectBatch',
    registerRendererFileOpenToken: 'dialog:registerRendererFileOpenToken',
    registerRendererFileOpenTokens: 'dialog:registerRendererFileOpenTokens',
    allowRendererFileOpen: 'dialog:allowRendererFileOpen',
    allowRendererFileOpenBatch: 'dialog:allowRendererFileOpenBatch',
    createWorkingCopyFromData: 'working-copy:createFromData',
    createWorkingCopyFromPath: 'working-copy:createFromPath',
    savePdfAs: 'dialog:savePdfAs',
    savePdfDataAs: 'dialog:savePdfDataAs',
    savePdfDataAsBegin: 'dialog:savePdfDataAs:begin',
    savePdfDialog: 'dialog:savePdfDialog',
    saveDocxAs: 'dialog:saveDocxAs',
    fileRead: 'file:read',
    fileStat: 'file:stat',
    fileReadRange: 'file:readRange',
    pdfNativePageSizes: 'pdf:nativePageSizes',
    pdfNativePagePreview: 'pdf:nativePagePreview',
    fileReadText: 'file:readText',
    fileExists: 'file:exists',
    documentRevisionGet: 'document:revision:get',
    pdfAnalyzeConformance: 'pdf:analyzeConformance',
    pdfValidateData: 'pdf:validateData',
    pdfValidatePath: 'pdf:validatePath',
    pdfOpenInDefaultAppData: 'pdf:openInDefaultAppData',
    pdfOpenInDefaultAppPath: 'pdf:openInDefaultAppPath',
    pdfPrintData: 'pdf:printData',
    pdfPrintPath: 'pdf:printPath',
    fileWrite: 'file:write',
    fileReplaceWorkingCopyFromPath: 'file:replaceWorkingCopyFromPath',
    fileWriteDocx: 'file:writeDocx',
    fileSaveStructured: 'file:saveStructured',
    fileRepairPdf: 'file:repairPdf',
    fileOptimizePdfForInteraction: 'file:optimizePdfForInteraction',
    fileOptimizePdfAsCopy: 'file:optimizePdfAsCopy',
    fileSavePdfData: 'file:savePdfData',
    fileSavePdfDataBegin: 'file:savePdfData:begin',
    fileSavePdfDataPort: 'file:savePdfData:port',
    fileSavePdfNoteTextUpdates: 'file:savePdfNoteTextUpdates',
    fileSavePdfNoteChanges: 'file:savePdfNoteChanges',
    fileSavePdfNativeMutations: 'file:savePdfNativeMutations',
    fileApplyPdfNativeMutationsToWorkingCopy: 'file:applyPdfNativeMutationsToWorkingCopy',
    fileCleanup: 'file:cleanup',
    fileCleanupOcrTemp: 'file:cleanupOcrTemp',
    windowSetTitle: 'window:setTitle',
    shellShowItemInFolder: 'shell:showItemInFolder',
    menuSetDocumentState: 'menu:setDocumentState',
    menuSetTabCount: 'menu:setTabCount',
    recentFilesGet: 'recentFiles:get',
    recentFilesRemove: 'recentFiles:remove',
    recentFilesClear: 'recentFiles:clear',
} as const;

export const DOCUMENTS_EVENT_CHANNELS = {
    menuOpenPdf: 'menu:openPdf',
    menuInsertImageFromFile: 'menu:insertImageFromFile',
    menuPasteImageFromClipboard: 'menu:pasteImageFromClipboard',
    menuSave: 'menu:save',
    menuRepairSave: 'menu:repairSave',
    menuOptimizePdfForInteraction: 'menu:optimizePdfForInteraction',
    menuSaveAs: 'menu:saveAs',
    menuPrint: 'menu:print',
    menuPrintCurrentPage: 'menu:printCurrentPage',
    menuExportDocx: 'menu:exportDocx',
    menuExportImages: 'menu:exportImages',
    menuExportMultiPageTiff: 'menu:exportMultiPageTiff',
    menuZoomIn: 'menu:zoomIn',
    menuZoomOut: 'menu:zoomOut',
    menuActualSize: 'menu:actualSize',
    menuFitWidth: 'menu:fitWidth',
    menuFitHeight: 'menu:fitHeight',
    menuViewModeSingle: 'menu:viewModeSingle',
    menuViewModeFacing: 'menu:viewModeFacing',
    menuViewModeFacingFirstSingle: 'menu:viewModeFacingFirstSingle',
    menuToggleAssistant: 'menu:toggleAssistant',
    menuUndo: 'menu:undo',
    menuRedo: 'menu:redo',
    menuDeletePages: 'menu:deletePages',
    menuExtractPages: 'menu:extractPages',
    menuRotateCw: 'menu:rotateCw',
    menuRotateCcw: 'menu:rotateCcw',
    menuInsertPages: 'menu:insertPages',
    menuOpenRecentFile: 'menu:openRecentFile',
    menuOpenExternalPaths: 'menu:openExternalPaths',
    menuClearRecentFiles: 'menu:clearRecentFiles',
    pdfOptimizeProgress: 'pdf:optimize:progress',
    openDocumentDirectBatchProgress: 'dialog:openPdfDirectBatch:progress',
    openPdfDirectBatchProgress: 'dialog:openPdfDirectBatch:progress',
    documentRevisionChanged: 'document:revision:changed',
} as const;

export type TOpenBatchProgressPayload = ICreatePdfFromInputPathsProgress & {
    operation: TOpenBatchProgressOperation;
    requestId: string;
};

export type TPdfOptimizeProgressPayload = IPdfOptimizeProgress;

export interface IDocumentsInvokeMap {
    [DOCUMENTS_CHANNELS.openDocumentDialog]: {
        args: [];
        result: Awaited<ReturnType<IDocumentsFileCapability['openDocumentDialog']>>;
    };
    [DOCUMENTS_CHANNELS.openCombineDialog]: {
        args: [];
        result: Awaited<ReturnType<IDocumentsFileCapability['openCombineDialog']>>;
    };
    [DOCUMENTS_CHANNELS.openFolderDialog]: {
        args: [];
        result: Awaited<ReturnType<IDocumentsFileCapability['openFolderDialog']>>;
    };
    [DOCUMENTS_CHANNELS.openImageDialog]: {
        args: [];
        result: Awaited<ReturnType<IDocumentsFileCapability['openImageDialog']>>;
    };
    [DOCUMENTS_CHANNELS.openDocumentDirect]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['openDocumentDirect']>>;
    };
    [DOCUMENTS_CHANNELS.openDocumentDirectBatch]: {
        args: [paths: string[], requestId?: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['openDocumentDirectBatch']>>;
    };
    [DOCUMENTS_CHANNELS.registerRendererFileOpenToken]: {
        args: [token: string];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.registerRendererFileOpenTokens]: {
        args: [tokens: string[]];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.allowRendererFileOpen]: {
        args: [request: {
            filePath: string;
            token: string;
        }];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.allowRendererFileOpenBatch]: {
        args: [requests: Array<{
            filePath: string;
            token: string;
        }>];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.createWorkingCopyFromData]: {
        args: [fileName: string, data: Uint8Array, originalPath?: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['createWorkingCopyFromData']>>;
    };
    [DOCUMENTS_CHANNELS.createWorkingCopyFromPath]: {
        args: [sourcePath: string, originalPath?: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['createWorkingCopyFromPath']>>;
    };
    [DOCUMENTS_CHANNELS.savePdfAs]: {
        args: [workingPath: string, options?: IPdfSaveAsOptions];
        result: Awaited<ReturnType<IDocumentsFileCapability['savePdfAs']>>;
    };
    [DOCUMENTS_CHANNELS.savePdfDataAs]: {
        args: [workingPath: string, data: Uint8Array, options?: IPdfSaveAsOptions];
        result: Awaited<ReturnType<IDocumentsFileCapability['savePdfDataAs']>>;
    };
    [DOCUMENTS_CHANNELS.savePdfDataAsBegin]: {
        args: [workingPath: string, totalBytes: number, options?: IPdfSaveAsOptions];
        result: IBeginSerializedPdfSaveAsResult;
    };
    [DOCUMENTS_CHANNELS.savePdfDialog]: {
        args: [suggestedName: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['savePdfDialog']>>;
    };
    [DOCUMENTS_CHANNELS.saveDocxAs]: {
        args: [workingPath: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['saveDocxAs']>>;
    };
    [DOCUMENTS_CHANNELS.fileRead]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['readFile']>>;
    };
    [DOCUMENTS_CHANNELS.fileStat]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['statFile']>>;
    };
    [DOCUMENTS_CHANNELS.fileReadRange]: {
        args: [path: string, offset: number, length: number];
        result: Awaited<ReturnType<IDocumentsFileCapability['readFileRange']>>;
    };
    [DOCUMENTS_CHANNELS.pdfNativePageSizes]: {
        args: [path: string];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['getPdfNativePageSizes']>>>;
    };
    [DOCUMENTS_CHANNELS.pdfNativePagePreview]: {
        args: [path: string, pageNumber: number, options?: IPdfNativePagePreviewOptions];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['renderPdfNativePagePreview']>>>;
    };
    [DOCUMENTS_CHANNELS.fileReadText]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['readTextFile']>>;
    };
    [DOCUMENTS_CHANNELS.fileExists]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['fileExists']>>;
    };
    [DOCUMENTS_CHANNELS.documentRevisionGet]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['getDocumentRevision']>>;
    };
    [DOCUMENTS_CHANNELS.pdfAnalyzeConformance]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['analyzePdfConformance']>>;
    };
    [DOCUMENTS_CHANNELS.pdfValidateData]: {
        args: [data: Uint8Array, fileName?: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['validatePdfData']>>;
    };
    [DOCUMENTS_CHANNELS.pdfValidatePath]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['validatePdfPath']>>;
    };
    [DOCUMENTS_CHANNELS.pdfOpenInDefaultAppData]: {
        args: [data: Uint8Array, fileName?: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['openPdfInDefaultAppData']>>;
    };
    [DOCUMENTS_CHANNELS.pdfOpenInDefaultAppPath]: {
        args: [path: string, fileName?: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['openPdfInDefaultAppPath']>>;
    };
    [DOCUMENTS_CHANNELS.pdfPrintData]: {
        args: [data: Uint8Array, fileName?: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['printPdfData']>>;
    };
    [DOCUMENTS_CHANNELS.pdfPrintPath]: {
        args: [path: string, fileName?: string, pageNumbers?: number[]];
        result: Awaited<ReturnType<IDocumentsFileCapability['printPdfPath']>>;
    };
    [DOCUMENTS_CHANNELS.fileWrite]: {
        args: [path: string, data: Uint8Array];
        result: Awaited<ReturnType<IDocumentsFileCapability['writeFile']>>;
    };
    [DOCUMENTS_CHANNELS.fileReplaceWorkingCopyFromPath]: {
        args: [workingCopyPath: string, sourcePath: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['replaceWorkingCopyFromPath']>>;
    };
    [DOCUMENTS_CHANNELS.fileWriteDocx]: {
        args: [path: string, data: Uint8Array];
        result: Awaited<ReturnType<IDocumentsFileCapability['writeDocxFile']>>;
    };
    [DOCUMENTS_CHANNELS.fileSaveStructured]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['saveFileStructured']>>;
    };
    [DOCUMENTS_CHANNELS.fileRepairPdf]: {
        args: [path: string];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['repairPdf']>>>;
    };
    [DOCUMENTS_CHANNELS.fileOptimizePdfForInteraction]: {
        args: [path: string];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['optimizePdfForInteraction']>>>;
    };
    [DOCUMENTS_CHANNELS.fileOptimizePdfAsCopy]: {
        args: [path: string, options: IPdfOptimizeOptions, requestId?: string];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['optimizePdfAsCopy']>>>;
    };
    [DOCUMENTS_CHANNELS.fileSavePdfData]: {
        args: [path: string, data: Uint8Array];
        result: Awaited<ReturnType<IDocumentsFileCapability['savePdfData']>>;
    };
    [DOCUMENTS_CHANNELS.fileSavePdfDataBegin]: {
        args: [path: string, totalBytes: number];
        result: IBeginSerializedPdfPersistenceResult;
    };
    [DOCUMENTS_CHANNELS.fileSavePdfNoteTextUpdates]: {
        args: [
            path: string,
            updates: Parameters<NonNullable<IDocumentsFileCapability['savePdfNoteTextUpdates']>>[1],
            modifiedAt: string,
        ];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['savePdfNoteTextUpdates']>>>;
    };
    [DOCUMENTS_CHANNELS.fileSavePdfNoteChanges]: {
        args: [
            path: string,
            changes: Parameters<NonNullable<IDocumentsFileCapability['savePdfNoteChanges']>>[1],
            modifiedAt: string,
        ];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['savePdfNoteChanges']>>>;
    };
    [DOCUMENTS_CHANNELS.fileSavePdfNativeMutations]: {
        args: [
            path: string,
            mutations: Parameters<NonNullable<IDocumentsFileCapability['savePdfNativeMutations']>>[1],
            modifiedAt: string,
        ];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['savePdfNativeMutations']>>>;
    };
    [DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy]: {
        args: [
            path: string,
            mutations: Parameters<NonNullable<IDocumentsFileCapability['applyPdfNativeMutationsToWorkingCopy']>>[1],
            modifiedAt: string,
            expectedBase: Parameters<NonNullable<IDocumentsFileCapability['applyPdfNativeMutationsToWorkingCopy']>>[3],
        ];
        result: Awaited<ReturnType<NonNullable<IDocumentsFileCapability['applyPdfNativeMutationsToWorkingCopy']>>>;
    };
    [DOCUMENTS_CHANNELS.fileCleanup]: {
        args: [path: string];
        result: undefined;
    };
    [DOCUMENTS_CHANNELS.fileCleanupOcrTemp]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['cleanupOcrTemp']>>;
    };
    [DOCUMENTS_CHANNELS.windowSetTitle]: {
        args: [title: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['setWindowTitle']>>;
    };
    [DOCUMENTS_CHANNELS.shellShowItemInFolder]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['showItemInFolder']>>;
    };
    [DOCUMENTS_CHANNELS.menuSetDocumentState]: {
        args: [state: Parameters<IDocumentsMenuCapability['setMenuDocumentState']>[0]];
        result: Awaited<ReturnType<IDocumentsMenuCapability['setMenuDocumentState']>>;
    };
    [DOCUMENTS_CHANNELS.menuSetTabCount]: {
        args: [tabCount: number];
        result: Awaited<ReturnType<IDocumentsMenuCapability['setMenuTabCount']>>;
    };
    [DOCUMENTS_CHANNELS.recentFilesGet]: {
        args: [];
        result: Awaited<ReturnType<IDocumentsFileCapability['recentFiles']['get']>>;
    };
    [DOCUMENTS_CHANNELS.recentFilesRemove]: {
        args: [path: string];
        result: Awaited<ReturnType<IDocumentsFileCapability['recentFiles']['remove']>>;
    };
    [DOCUMENTS_CHANNELS.recentFilesClear]: {
        args: [];
        result: Awaited<ReturnType<IDocumentsFileCapability['recentFiles']['clear']>>;
    };
}

export interface IDocumentsEventMap {
    [DOCUMENTS_EVENT_CHANNELS.menuOpenPdf]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuInsertImageFromFile]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuPasteImageFromClipboard]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuSave]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuRepairSave]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuOptimizePdfForInteraction]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuSaveAs]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuPrint]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuPrintCurrentPage]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuExportDocx]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuExportImages]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuExportMultiPageTiff]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuZoomIn]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuZoomOut]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuActualSize]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuFitWidth]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuFitHeight]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuViewModeSingle]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuViewModeFacing]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuViewModeFacingFirstSingle]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuToggleAssistant]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuUndo]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuRedo]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuDeletePages]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuExtractPages]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuRotateCw]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuRotateCcw]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuInsertPages]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.menuOpenRecentFile]: string;
    [DOCUMENTS_EVENT_CHANNELS.menuOpenExternalPaths]: string[];
    [DOCUMENTS_EVENT_CHANNELS.menuClearRecentFiles]: undefined;
    [DOCUMENTS_EVENT_CHANNELS.pdfOptimizeProgress]: TPdfOptimizeProgressPayload;
    [DOCUMENTS_EVENT_CHANNELS.openDocumentDirectBatchProgress]: TOpenDocumentDirectBatchProgress;
    [DOCUMENTS_EVENT_CHANNELS.documentRevisionChanged]: IDocumentRevisionChangedEvent;
}

export type { TOpenFileResult } from '@contracts/electronApiDocuments';
