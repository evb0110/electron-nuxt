import type {
    IDjvuCapability,
    IDocumentsCapability,
    IHostCapability,
    IImageExportCapability,
    IOcrCapability,
    IPageOpsCapability,
    IPlatformApi,
    ISearchCapability,
    ISettingsCapability,
    IUpdatesCapability,
    IWindowTabsCapability,
} from '@contracts/platformApi';
import { isRecord } from '@contracts/runtimeGuards';
import { browserDocumentStore } from '@app/platform/browserDocumentStore';

type TBrowserPlatformModule = { browserPlatformApi: IPlatformApi; };
type TPropertyPath = Array<string | symbol>;
type TUnsubscribe = () => void;
type TCallableBrowserMember = (...args: unknown[]) => unknown;
type TArgs<TMethod> = TMethod extends (...args: infer TMethodArgs) => unknown ? TMethodArgs : never;
type TAsyncResult<TMethod> = TMethod extends (...args: unknown[]) => Promise<infer TResult> ? TResult : never;

let browserPlatformApiPromise: Promise<IPlatformApi> | null = null;

function loadBrowserPlatformApi() {
    browserPlatformApiPromise ??= import('@app/platform/browserApi').then(
        (module: TBrowserPlatformModule) => module.browserPlatformApi,
    );
    return browserPlatformApiPromise;
}

async function resolveBrowserProperty(path: TPropertyPath) {
    let value: unknown = await loadBrowserPlatformApi();
    for (const key of path) {
        if (!isRecord(value)) {
            throw new TypeError(`Browser platform owner for ${String(key)} is not an object`);
        }
        value = value[key];
    }
    return value;
}

function splitOwnerPath(path: TPropertyPath) {
    const methodKey = path.at(-1);
    if (methodKey === undefined) {
        throw new TypeError('Browser platform method path is empty');
    }
    return {
        methodKey,
        ownerPath: path.slice(0, -1),
    };
}

function getCallableBrowserMember(owner: unknown, methodKey: string | symbol) {
    if (!isRecord(owner)) {
        throw new TypeError(`Browser platform owner for ${String(methodKey)} is not an object`);
    }
    const method = owner[methodKey];
    if (typeof method !== 'function') {
        throw new TypeError(`Browser platform member ${String(methodKey)} is not callable`);
    }
    return method as TCallableBrowserMember;
}

async function resolveBrowserMethod(path: TPropertyPath) {
    const {
        methodKey,
        ownerPath,
    } = splitOwnerPath(path);
    const api = await loadBrowserPlatformApi();
    const owner = ownerPath.length === 0
        ? api
        : await resolveBrowserProperty(ownerPath);
    const callable = getCallableBrowserMember(owner, methodKey);
    return {
        callable,
        owner,
    };
}

async function callBrowserMethod<TResult>(path: TPropertyPath, args: unknown[]) {
    const {
        callable,
        owner,
    } = await resolveBrowserMethod(path);
    const result: unknown = callable.apply(owner, args);
    return await result as TResult;
}

function subscribeToBrowserEvent(path: TPropertyPath, args: unknown[]): TUnsubscribe {
    let active = true;
    let unsubscribe: TUnsubscribe | null = null;

    void resolveBrowserMethod(path).then(({
        callable,
        owner,
    }) => {
        if (!active) {
            return;
        }
        const cleanup: unknown = callable.apply(owner, args);
        if (active && typeof cleanup === 'function') {
            unsubscribe = cleanup as TUnsubscribe;
        } else if (!active && typeof cleanup === 'function') {
            (cleanup as TUnsubscribe)();
        }
    });

    return () => {
        active = false;
        unsubscribe?.();
        unsubscribe = null;
    };
}

function lazyAsync<TMethod>(path: TPropertyPath) {
    return (...args: TArgs<TMethod>) => callBrowserMethod<TAsyncResult<TMethod>>(path, args);
}

function lazyEvent<TMethod>(path: TPropertyPath) {
    return (...args: TArgs<TMethod>) => subscribeToBrowserEvent(path, args);
}

function lazyVoid<TMethod>(path: TPropertyPath) {
    return (...args: TArgs<TMethod>) => {
        void callBrowserMethod<unknown>(path, args);
    };
}

const lazyDocumentsCapability: IDocumentsCapability = {
    openPdfDialog: lazyAsync<IDocumentsCapability['openPdfDialog']>([
        'documents',
        'openPdfDialog',
    ]),
    openCombineDialog: lazyAsync<IDocumentsCapability['openCombineDialog']>([
        'documents',
        'openCombineDialog',
    ]),
    openFolderDialog: lazyAsync<IDocumentsCapability['openFolderDialog']>([
        'documents',
        'openFolderDialog',
    ]),
    openImageDialog: lazyAsync<IDocumentsCapability['openImageDialog']>([
        'documents',
        'openImageDialog',
    ]),
    openPdfDirect: lazyAsync<IDocumentsCapability['openPdfDirect']>([
        'documents',
        'openPdfDirect',
    ]),
    openPdfDirectBatch: lazyAsync<IDocumentsCapability['openPdfDirectBatch']>([
        'documents',
        'openPdfDirectBatch',
    ]),
    savePdfAs: lazyAsync<IDocumentsCapability['savePdfAs']>([
        'documents',
        'savePdfAs',
    ]),
    savePdfDataAs: lazyAsync<IDocumentsCapability['savePdfDataAs']>([
        'documents',
        'savePdfDataAs',
    ]),
    savePdfDialog: lazyAsync<IDocumentsCapability['savePdfDialog']>([
        'documents',
        'savePdfDialog',
    ]),
    saveDocxAs: lazyAsync<IDocumentsCapability['saveDocxAs']>([
        'documents',
        'saveDocxAs',
    ]),
    readFile: lazyAsync<IDocumentsCapability['readFile']>([
        'documents',
        'readFile',
    ]),
    statFile: lazyAsync<IDocumentsCapability['statFile']>([
        'documents',
        'statFile',
    ]),
    readFileRange: lazyAsync<IDocumentsCapability['readFileRange']>([
        'documents',
        'readFileRange',
    ]),
    readTextFile: lazyAsync<IDocumentsCapability['readTextFile']>([
        'documents',
        'readTextFile',
    ]),
    fileExists: lazyAsync<IDocumentsCapability['fileExists']>([
        'documents',
        'fileExists',
    ]),
    analyzePdfConformance: lazyAsync<IDocumentsCapability['analyzePdfConformance']>([
        'documents',
        'analyzePdfConformance',
    ]),
    validatePdfData: lazyAsync<IDocumentsCapability['validatePdfData']>([
        'documents',
        'validatePdfData',
    ]),
    validatePdfPath: lazyAsync<IDocumentsCapability['validatePdfPath']>([
        'documents',
        'validatePdfPath',
    ]),
    openPdfInDefaultAppData: lazyAsync<IDocumentsCapability['openPdfInDefaultAppData']>([
        'documents',
        'openPdfInDefaultAppData',
    ]),
    openPdfInDefaultAppPath: lazyAsync<IDocumentsCapability['openPdfInDefaultAppPath']>([
        'documents',
        'openPdfInDefaultAppPath',
    ]),
    printPdfData: lazyAsync<IDocumentsCapability['printPdfData']>([
        'documents',
        'printPdfData',
    ]),
    printPdfPath: lazyAsync<IDocumentsCapability['printPdfPath']>([
        'documents',
        'printPdfPath',
    ]),
    writeFile: lazyAsync<IDocumentsCapability['writeFile']>([
        'documents',
        'writeFile',
    ]),
    writeDocxFile: lazyAsync<IDocumentsCapability['writeDocxFile']>([
        'documents',
        'writeDocxFile',
    ]),
    createWorkingCopyFromData: lazyAsync<IDocumentsCapability['createWorkingCopyFromData']>([
        'documents',
        'createWorkingCopyFromData',
    ]),
    createWorkingCopyFromPath: lazyAsync<IDocumentsCapability['createWorkingCopyFromPath']>([
        'documents',
        'createWorkingCopyFromPath',
    ]),
    saveFile: lazyAsync<IDocumentsCapability['saveFile']>([
        'documents',
        'saveFile',
    ]),
    savePdfData: lazyAsync<IDocumentsCapability['savePdfData']>([
        'documents',
        'savePdfData',
    ]),
    cleanupFile: lazyAsync<IDocumentsCapability['cleanupFile']>([
        'documents',
        'cleanupFile',
    ]),
    cleanupOcrTemp: lazyAsync<IDocumentsCapability['cleanupOcrTemp']>([
        'documents',
        'cleanupOcrTemp',
    ]),
    setWindowTitle: lazyAsync<IDocumentsCapability['setWindowTitle']>([
        'documents',
        'setWindowTitle',
    ]),
    showItemInFolder: lazyAsync<IDocumentsCapability['showItemInFolder']>([
        'documents',
        'showItemInFolder',
    ]),
    recentFiles: {
        get: lazyAsync<IDocumentsCapability['recentFiles']['get']>([
            'documents',
            'recentFiles',
            'get',
        ]),
        remove: lazyAsync<IDocumentsCapability['recentFiles']['remove']>([
            'documents',
            'recentFiles',
            'remove',
        ]),
        clear: lazyAsync<IDocumentsCapability['recentFiles']['clear']>([
            'documents',
            'recentFiles',
            'clear',
        ]),
    },
    getPathForFile(file) {
        return browserDocumentStore.getRefForFile(file);
    },
    setMenuDocumentState: lazyAsync<IDocumentsCapability['setMenuDocumentState']>([
        'documents',
        'setMenuDocumentState',
    ]),
    setMenuTabCount: lazyAsync<IDocumentsCapability['setMenuTabCount']>([
        'documents',
        'setMenuTabCount',
    ]),
    onMenuOpenPdf: lazyEvent<IDocumentsCapability['onMenuOpenPdf']>([
        'documents',
        'onMenuOpenPdf',
    ]),
    onMenuInsertImageFromFile: lazyEvent<IDocumentsCapability['onMenuInsertImageFromFile']>([
        'documents',
        'onMenuInsertImageFromFile',
    ]),
    onMenuPasteImageFromClipboard: lazyEvent<IDocumentsCapability['onMenuPasteImageFromClipboard']>([
        'documents',
        'onMenuPasteImageFromClipboard',
    ]),
    onMenuSave: lazyEvent<IDocumentsCapability['onMenuSave']>([
        'documents',
        'onMenuSave',
    ]),
    onMenuSaveAs: lazyEvent<IDocumentsCapability['onMenuSaveAs']>([
        'documents',
        'onMenuSaveAs',
    ]),
    onMenuPrint: lazyEvent<IDocumentsCapability['onMenuPrint']>([
        'documents',
        'onMenuPrint',
    ]),
    onMenuPrintCurrentPage: lazyEvent<IDocumentsCapability['onMenuPrintCurrentPage']>([
        'documents',
        'onMenuPrintCurrentPage',
    ]),
    onMenuExportDocx: lazyEvent<IDocumentsCapability['onMenuExportDocx']>([
        'documents',
        'onMenuExportDocx',
    ]),
    onMenuExportImages: lazyEvent<IDocumentsCapability['onMenuExportImages']>([
        'documents',
        'onMenuExportImages',
    ]),
    onMenuExportMultiPageTiff: lazyEvent<IDocumentsCapability['onMenuExportMultiPageTiff']>([
        'documents',
        'onMenuExportMultiPageTiff',
    ]),
    onMenuZoomIn: lazyEvent<IDocumentsCapability['onMenuZoomIn']>([
        'documents',
        'onMenuZoomIn',
    ]),
    onMenuZoomOut: lazyEvent<IDocumentsCapability['onMenuZoomOut']>([
        'documents',
        'onMenuZoomOut',
    ]),
    onMenuActualSize: lazyEvent<IDocumentsCapability['onMenuActualSize']>([
        'documents',
        'onMenuActualSize',
    ]),
    onMenuFitWidth: lazyEvent<IDocumentsCapability['onMenuFitWidth']>([
        'documents',
        'onMenuFitWidth',
    ]),
    onMenuFitHeight: lazyEvent<IDocumentsCapability['onMenuFitHeight']>([
        'documents',
        'onMenuFitHeight',
    ]),
    onMenuViewModeSingle: lazyEvent<IDocumentsCapability['onMenuViewModeSingle']>([
        'documents',
        'onMenuViewModeSingle',
    ]),
    onMenuViewModeFacing: lazyEvent<IDocumentsCapability['onMenuViewModeFacing']>([
        'documents',
        'onMenuViewModeFacing',
    ]),
    onMenuViewModeFacingFirstSingle: lazyEvent<IDocumentsCapability['onMenuViewModeFacingFirstSingle']>([
        'documents',
        'onMenuViewModeFacingFirstSingle',
    ]),
    onMenuUndo: lazyEvent<IDocumentsCapability['onMenuUndo']>([
        'documents',
        'onMenuUndo',
    ]),
    onMenuRedo: lazyEvent<IDocumentsCapability['onMenuRedo']>([
        'documents',
        'onMenuRedo',
    ]),
    onMenuDeletePages: lazyEvent<IDocumentsCapability['onMenuDeletePages']>([
        'documents',
        'onMenuDeletePages',
    ]),
    onMenuExtractPages: lazyEvent<IDocumentsCapability['onMenuExtractPages']>([
        'documents',
        'onMenuExtractPages',
    ]),
    onMenuRotateCw: lazyEvent<IDocumentsCapability['onMenuRotateCw']>([
        'documents',
        'onMenuRotateCw',
    ]),
    onMenuRotateCcw: lazyEvent<IDocumentsCapability['onMenuRotateCcw']>([
        'documents',
        'onMenuRotateCcw',
    ]),
    onMenuInsertPages: lazyEvent<IDocumentsCapability['onMenuInsertPages']>([
        'documents',
        'onMenuInsertPages',
    ]),
    onMenuOpenRecentFile: lazyEvent<IDocumentsCapability['onMenuOpenRecentFile']>([
        'documents',
        'onMenuOpenRecentFile',
    ]),
    onMenuOpenExternalPaths: lazyEvent<IDocumentsCapability['onMenuOpenExternalPaths']>([
        'documents',
        'onMenuOpenExternalPaths',
    ]),
    onMenuClearRecentFiles: lazyEvent<IDocumentsCapability['onMenuClearRecentFiles']>([
        'documents',
        'onMenuClearRecentFiles',
    ]),
    onOpenPdfDirectBatchProgress: lazyEvent<IDocumentsCapability['onOpenPdfDirectBatchProgress']>([
        'documents',
        'onOpenPdfDirectBatchProgress',
    ]),
};

const lazyImageExportCapability: IImageExportCapability = {
    exportPdfToImages: lazyAsync<IImageExportCapability['exportPdfToImages']>([
        'imageExport',
        'exportPdfToImages',
    ]),
    exportPdfToMultiPageTiff: lazyAsync<IImageExportCapability['exportPdfToMultiPageTiff']>([
        'imageExport',
        'exportPdfToMultiPageTiff',
    ]),
};

const lazyPageOpsCapability: IPageOpsCapability = {
    delete: lazyAsync<IPageOpsCapability['delete']>([
        'pageOps',
        'delete',
    ]),
    extract: lazyAsync<IPageOpsCapability['extract']>([
        'pageOps',
        'extract',
    ]),
    reorder: lazyAsync<IPageOpsCapability['reorder']>([
        'pageOps',
        'reorder',
    ]),
    insert: lazyAsync<IPageOpsCapability['insert']>([
        'pageOps',
        'insert',
    ]),
    insertFile: lazyAsync<IPageOpsCapability['insertFile']>([
        'pageOps',
        'insertFile',
    ]),
    rotate: lazyAsync<IPageOpsCapability['rotate']>([
        'pageOps',
        'rotate',
    ]),
    crop: lazyAsync<IPageOpsCapability['crop']>([
        'pageOps',
        'crop',
    ]),
    removeCrop: lazyAsync<IPageOpsCapability['removeCrop']>([
        'pageOps',
        'removeCrop',
    ]),
    getPageGeometry: lazyAsync<IPageOpsCapability['getPageGeometry']>([
        'pageOps',
        'getPageGeometry',
    ]),
};

const lazyOcrCapability: IOcrCapability = {
    recognize: lazyAsync<IOcrCapability['recognize']>([
        'ocr',
        'recognize',
    ]),
    recognizeBatch: lazyAsync<IOcrCapability['recognizeBatch']>([
        'ocr',
        'recognizeBatch',
    ]),
    cancel: lazyAsync<IOcrCapability['cancel']>([
        'ocr',
        'cancel',
    ]),
    getLanguages: lazyAsync<IOcrCapability['getLanguages']>([
        'ocr',
        'getLanguages',
    ]),
    validateTools: lazyAsync<IOcrCapability['validateTools']>([
        'ocr',
        'validateTools',
    ]),
    installLanguages: lazyAsync<IOcrCapability['installLanguages']>([
        'ocr',
        'installLanguages',
    ]),
    acknowledgeResultFile: lazyAsync<IOcrCapability['acknowledgeResultFile']>([
        'ocr',
        'acknowledgeResultFile',
    ]),
    createSearchablePdf: lazyAsync<IOcrCapability['createSearchablePdf']>([
        'ocr',
        'createSearchablePdf',
    ]),
    onProgress: lazyEvent<IOcrCapability['onProgress']>([
        'ocr',
        'onProgress',
    ]),
    onComplete: lazyEvent<IOcrCapability['onComplete']>([
        'ocr',
        'onComplete',
    ]),
    preprocessing: {
        validate: lazyAsync<IOcrCapability['preprocessing']['validate']>([
            'ocr',
            'preprocessing',
            'validate',
        ]),
        preprocessPage: lazyAsync<IOcrCapability['preprocessing']['preprocessPage']>([
            'ocr',
            'preprocessing',
            'preprocessPage',
        ]),
    },
};

const lazySearchCapability: ISearchCapability = {
    run: lazyAsync<ISearchCapability['run']>([
        'search',
        'run',
    ]),
    warmIndex: lazyAsync<ISearchCapability['warmIndex']>([
        'search',
        'warmIndex',
    ]),
    cancel: lazyAsync<ISearchCapability['cancel']>([
        'search',
        'cancel',
    ]),
    onProgress: lazyEvent<ISearchCapability['onProgress']>([
        'search',
        'onProgress',
    ]),
    resetCache: lazyAsync<ISearchCapability['resetCache']>([
        'search',
        'resetCache',
    ]),
};

const lazyDjvuCapability: IDjvuCapability = {
    openForViewing: lazyAsync<IDjvuCapability['openForViewing']>([
        'djvu',
        'openForViewing',
    ]),
    releaseViewingPath: lazyAsync<IDjvuCapability['releaseViewingPath']>([
        'djvu',
        'releaseViewingPath',
    ]),
    convertToPdf: lazyAsync<IDjvuCapability['convertToPdf']>([
        'djvu',
        'convertToPdf',
    ]),
    cancel: lazyAsync<IDjvuCapability['cancel']>([
        'djvu',
        'cancel',
    ]),
    getInfo: lazyAsync<IDjvuCapability['getInfo']>([
        'djvu',
        'getInfo',
    ]),
    estimateSizes: lazyAsync<IDjvuCapability['estimateSizes']>([
        'djvu',
        'estimateSizes',
    ]),
    cleanupTemp: lazyAsync<IDjvuCapability['cleanupTemp']>([
        'djvu',
        'cleanupTemp',
    ]),
    onProgress: lazyEvent<IDjvuCapability['onProgress']>([
        'djvu',
        'onProgress',
    ]),
    onViewingReady: lazyEvent<IDjvuCapability['onViewingReady']>([
        'djvu',
        'onViewingReady',
    ]),
    onViewingError: lazyEvent<IDjvuCapability['onViewingError']>([
        'djvu',
        'onViewingError',
    ]),
    onMenuConvertToPdf: lazyEvent<IDjvuCapability['onMenuConvertToPdf']>([
        'djvu',
        'onMenuConvertToPdf',
    ]),
};

const lazySettingsCapability: ISettingsCapability = {
    get: lazyAsync<ISettingsCapability['get']>([
        'settings',
        'get',
    ]),
    save: lazyAsync<ISettingsCapability['save']>([
        'settings',
        'save',
    ]),
    getDebugLogs: lazyAsync<ISettingsCapability['getDebugLogs']>([
        'settings',
        'getDebugLogs',
    ]),
    onDebugLog: lazyEvent<ISettingsCapability['onDebugLog']>([
        'settings',
        'onDebugLog',
    ]),
    rendererLog: lazyVoid<ISettingsCapability['rendererLog']>([
        'settings',
        'rendererLog',
    ]),
    onMenuOpenSettings: lazyEvent<ISettingsCapability['onMenuOpenSettings']>([
        'settings',
        'onMenuOpenSettings',
    ]),
};

const lazyUpdatesCapability: IUpdatesCapability = {
    getState: lazyAsync<IUpdatesCapability['getState']>([
        'updates',
        'getState',
    ]),
    check: lazyAsync<IUpdatesCapability['check']>([
        'updates',
        'check',
    ]),
    install: lazyAsync<IUpdatesCapability['install']>([
        'updates',
        'install',
    ]),
    defer: lazyAsync<IUpdatesCapability['defer']>([
        'updates',
        'defer',
    ]),
    skipVersion: lazyAsync<IUpdatesCapability['skipVersion']>([
        'updates',
        'skipVersion',
    ]),
    onStatus: lazyEvent<IUpdatesCapability['onStatus']>([
        'updates',
        'onStatus',
    ]),
    onMenuCheckForUpdates: lazyEvent<IUpdatesCapability['onMenuCheckForUpdates']>([
        'updates',
        'onMenuCheckForUpdates',
    ]),
};

const lazyWindowTabsCapability: IWindowTabsCapability = {
    transfer: lazyAsync<IWindowTabsCapability['transfer']>([
        'windowTabs',
        'transfer',
    ]),
    transferAck: lazyAsync<IWindowTabsCapability['transferAck']>([
        'windowTabs',
        'transferAck',
    ]),
    listTargetWindows: lazyAsync<IWindowTabsCapability['listTargetWindows']>([
        'windowTabs',
        'listTargetWindows',
    ]),
    showContextMenu: lazyAsync<IWindowTabsCapability['showContextMenu']>([
        'windowTabs',
        'showContextMenu',
    ]),
    onIncomingTransfer: lazyEvent<IWindowTabsCapability['onIncomingTransfer']>([
        'windowTabs',
        'onIncomingTransfer',
    ]),
    onWindowAction: lazyEvent<IWindowTabsCapability['onWindowAction']>([
        'windowTabs',
        'onWindowAction',
    ]),
    closeCurrentWindow: lazyAsync<IWindowTabsCapability['closeCurrentWindow']>([
        'windowTabs',
        'closeCurrentWindow',
    ]),
    notifyRendererReady: lazyVoid<IWindowTabsCapability['notifyRendererReady']>([
        'windowTabs',
        'notifyRendererReady',
    ]),
    claimPendingExternalOpenPaths: lazyAsync<IWindowTabsCapability['claimPendingExternalOpenPaths']>([
        'windowTabs',
        'claimPendingExternalOpenPaths',
    ]),
    onMenuNewTab: lazyEvent<IWindowTabsCapability['onMenuNewTab']>([
        'windowTabs',
        'onMenuNewTab',
    ]),
    onMenuCloseTab: lazyEvent<IWindowTabsCapability['onMenuCloseTab']>([
        'windowTabs',
        'onMenuCloseTab',
    ]),
    onMenuSplitEditor: lazyEvent<IWindowTabsCapability['onMenuSplitEditor']>([
        'windowTabs',
        'onMenuSplitEditor',
    ]),
    onMenuFocusEditorGroup: lazyEvent<IWindowTabsCapability['onMenuFocusEditorGroup']>([
        'windowTabs',
        'onMenuFocusEditorGroup',
    ]),
    onMenuMoveTabToGroup: lazyEvent<IWindowTabsCapability['onMenuMoveTabToGroup']>([
        'windowTabs',
        'onMenuMoveTabToGroup',
    ]),
    onMenuCopyTabToGroup: lazyEvent<IWindowTabsCapability['onMenuCopyTabToGroup']>([
        'windowTabs',
        'onMenuCopyTabToGroup',
    ]),
};

const lazyShellCapability: IPlatformApi['shell'] = {openExternal: lazyAsync<IPlatformApi['shell']['openExternal']>([
    'shell',
    'openExternal',
])};

const lazyHostCapability: IHostCapability = {
    getEnvironment: lazyAsync<IHostCapability['getEnvironment']>([
        'host',
        'getEnvironment',
    ]),
    onEnvironmentChange: lazyEvent<IHostCapability['onEnvironmentChange']>([
        'host',
        'onEnvironmentChange',
    ]),
    getZenModeState: lazyAsync<IHostCapability['getZenModeState']>([
        'host',
        'getZenModeState',
    ]),
    setZenMode: lazyAsync<IHostCapability['setZenMode']>([
        'host',
        'setZenMode',
    ]),
    onZenModeChange: lazyEvent<IHostCapability['onZenModeChange']>([
        'host',
        'onZenModeChange',
    ]),
};

export const lazyBrowserPlatformApi = {
    documents: lazyDocumentsCapability,
    pageOps: lazyPageOpsCapability,
    imageExport: lazyImageExportCapability,
    ocr: lazyOcrCapability,
    search: lazySearchCapability,
    djvu: lazyDjvuCapability,
    settings: lazySettingsCapability,
    updates: lazyUpdatesCapability,
    windowTabs: lazyWindowTabsCapability,
    shell: lazyShellCapability,
    host: lazyHostCapability,
} satisfies IPlatformApi;
