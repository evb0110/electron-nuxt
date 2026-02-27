export const DOCUMENTS_CHANNELS = {
    openPdfDialog: 'dialog:openPdf',
    openPdfDirect: 'dialog:openPdfDirect',
    openPdfDirectBatch: 'dialog:openPdfDirectBatch',
    createWorkingCopyFromData: 'working-copy:createFromData',
    savePdfAs: 'dialog:savePdfAs',
    savePdfDialog: 'dialog:savePdfDialog',
    saveDocxAs: 'dialog:saveDocxAs',
    fileRead: 'file:read',
    fileStat: 'file:stat',
    fileReadRange: 'file:readRange',
    fileReadText: 'file:readText',
    fileExists: 'file:exists',
    fileWrite: 'file:write',
    fileWriteDocx: 'file:writeDocx',
    fileSave: 'file:save',
    fileCleanup: 'file:cleanup',
    fileCleanupOcrTemp: 'file:cleanupOcrTemp',
    windowSetTitle: 'window:setTitle',
    shellShowItemInFolder: 'shell:showItemInFolder',
    menuSetDocumentState: 'menu:setDocumentState',
    menuSetTabCount: 'menu:setTabCount',
    recentFilesGet: 'recent-files:get',
    recentFilesAdd: 'recent-files:add',
    recentFilesRemove: 'recent-files:remove',
    recentFilesClear: 'recent-files:clear',
} as const;

export const DOCUMENTS_EVENT_CHANNELS = {
    menuOpenPdf: 'menu:openPdf',
    menuSave: 'menu:save',
    menuSaveAs: 'menu:saveAs',
    menuExportDocx: 'menu:exportDocx',
    menuOpenRecentFile: 'menu:openRecentFile',
    menuOpenExternalPaths: 'menu:openExternalPaths',
    menuClearRecentFiles: 'menu:clearRecentFiles',
    openPdfDirectBatchProgress: 'dialog:openPdfDirectBatch:progress',
} as const;

export interface IOpenPdfResult {
    kind: 'pdf';
    workingPath: string;
    originalPath: string;
    isGenerated?: boolean;
}

export interface IOpenDjvuResult {
    kind: 'djvu';
    workingPath: '';
    originalPath: string;
}

export type TOpenFileResult = IOpenPdfResult | IOpenDjvuResult;

interface IOpenPdfDirectBatchProgress {
    requestId: string;
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface IExportPdfToImagesResult {
    success: boolean;
    canceled?: boolean;
    outputPaths?: string[];
}

interface IExportPdfToMultiPageTiffResult {
    success: boolean;
    canceled?: boolean;
    outputPath?: string;
}
