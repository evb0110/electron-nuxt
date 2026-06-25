import type { IPlatformApi } from '@contracts/platformApi';
import type { IAgentCapability } from '@contracts/agentCapability';
import type { IDjvuCapability } from '@contracts/electronApiDjvu';
import type {
    IDocumentsCapability,
    IImageExportCapability,
} from '@contracts/electronApiDocuments';
import type { IHostCapability } from '@contracts/electronApiHost';
import type { IOcrCapability } from '@contracts/electronApiOcr';
import type { IPageOpsCapability } from '@contracts/electronApiPageOps';
import type { ISystemCapability } from '@contracts/electronApiSystem';
import type { IUpdatesCapability } from '@contracts/electronApiUpdates';
import type { IWindowTabsCapability } from '@contracts/electronApiWindowTabs';
import type { ISearchCapability } from '@contracts/searchCapability';
import type { ISettingsCapability } from '@contracts/settingsCapability';
import { isRecord } from '@contracts/runtimeGuards';
import {
    browserPlatformPathDescriptors,
    type TBrowserPlatformAsyncMethodPath,
    type TBrowserPlatformEventMethodPath,
    type TBrowserPlatformMethodPath,
    type TBrowserPlatformVoidMethodPath,
    type TMethodAtBrowserPlatformPath,
} from '@app/platform/browserPlatformPathDescriptors';
import { browserDocumentStore } from '@app/platform/browserDocumentStore';
import { BrowserLogger } from '@app/utils/browserLogger';

interface IBrowserPlatformModule { browserPlatformApi: IPlatformApi; }
type TPropertyPath = ReadonlyArray<string | symbol>;
type TUnsubscribe = () => void;
type TCallableBrowserMember = (...args: unknown[]) => unknown;
type TArgs<TPath extends TBrowserPlatformMethodPath> =
    TMethodAtBrowserPlatformPath<TPath> extends (...args: infer TMethodArgs) => unknown ? TMethodArgs : never;
type TAsyncResult<TPath extends TBrowserPlatformMethodPath> =
    TMethodAtBrowserPlatformPath<TPath> extends (...args: never[]) => Promise<infer TResult> ? TResult : never;

const pathDescriptors = browserPlatformPathDescriptors;

let browserPlatformApiPromise: Promise<IPlatformApi> | null = null;

function loadBrowserPlatformApi() {
    browserPlatformApiPromise ??= import('@app/platform/browserPlatformApi').then(
        (module: IBrowserPlatformModule) => module.browserPlatformApi,
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

function formatPropertyPath(path: TPropertyPath) {
    return path.map(key => String(key)).join('.');
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
    const guardedArgs = args.map((arg) => {
        if (typeof arg !== 'function') {
            return arg;
        }

        return (...callbackArgs: unknown[]) => {
            if (!active) {
                return undefined;
            }

            return (arg as (...args: unknown[]) => unknown)(...callbackArgs);
        };
    });

    void resolveBrowserMethod(path).then(({
        callable,
        owner,
    }) => {
        if (!active) {
            return;
        }
        const cleanup: unknown = callable.apply(owner, guardedArgs);
        if (active && typeof cleanup === 'function') {
            unsubscribe = cleanup as TUnsubscribe;
        } else if (!active && typeof cleanup === 'function') {
            (cleanup as TUnsubscribe)();
        }
    }).catch((error: unknown) => {
        if (active) {
            BrowserLogger.error(
                'platform',
                `Failed to subscribe to browser event ${formatPropertyPath(path)}`,
                error,
            );
        }
    });

    return () => {
        active = false;
        unsubscribe?.();
        unsubscribe = null;
    };
}

function lazyAsync<TPath extends TBrowserPlatformAsyncMethodPath>(
    path: TPath,
): TMethodAtBrowserPlatformPath<TPath> {
    return ((...args: TArgs<TPath>) =>
        callBrowserMethod<TAsyncResult<TPath>>(path, args)) as TMethodAtBrowserPlatformPath<TPath>;
}

function lazyEvent<TPath extends TBrowserPlatformEventMethodPath>(
    path: TPath,
): TMethodAtBrowserPlatformPath<TPath> {
    return ((...args: TArgs<TPath>) =>
        subscribeToBrowserEvent(path, args)) as TMethodAtBrowserPlatformPath<TPath>;
}

function lazyVoid<TPath extends TBrowserPlatformVoidMethodPath>(
    path: TPath,
): TMethodAtBrowserPlatformPath<TPath> {
    return ((...args: TArgs<TPath>) => {
        void callBrowserMethod<unknown>(path, args);
    }) as TMethodAtBrowserPlatformPath<TPath>;
}

const lazyDocumentsCapability: IDocumentsCapability = {
    openDocumentDialog: lazyAsync(pathDescriptors.documents.openDocumentDialog.path),
    openPdfDialog: lazyAsync(pathDescriptors.documents.openPdfDialog.path),
    openCombineDialog: lazyAsync(pathDescriptors.documents.openCombineDialog.path),
    openFolderDialog: lazyAsync(pathDescriptors.documents.openFolderDialog.path),
    openImageDialog: lazyAsync(pathDescriptors.documents.openImageDialog.path),
    openDocumentDirect: lazyAsync(pathDescriptors.documents.openDocumentDirect.path),
    openPdfDirect: lazyAsync(pathDescriptors.documents.openPdfDirect.path),
    openDocumentDirectBatch: lazyAsync(pathDescriptors.documents.openDocumentDirectBatch.path),
    openPdfDirectBatch: lazyAsync(pathDescriptors.documents.openPdfDirectBatch.path),
    savePdfAs: lazyAsync(pathDescriptors.documents.savePdfAs.path),
    savePdfDataAs: lazyAsync(pathDescriptors.documents.savePdfDataAs.path),
    savePdfDialog: lazyAsync(pathDescriptors.documents.savePdfDialog.path),
    saveDocxAs: lazyAsync(pathDescriptors.documents.saveDocxAs.path),
    readFile: lazyAsync(pathDescriptors.documents.readFile.path),
    statFile: lazyAsync(pathDescriptors.documents.statFile.path),
    readFileRange: lazyAsync(pathDescriptors.documents.readFileRange.path),
    readFileChunks: lazyAsync(pathDescriptors.documents.readFileChunks.path),
    readTextFile: lazyAsync(pathDescriptors.documents.readTextFile.path),
    fileExists: lazyAsync(pathDescriptors.documents.fileExists.path),
    analyzePdfConformance: lazyAsync(pathDescriptors.documents.analyzePdfConformance.path),
    validatePdfData: lazyAsync(pathDescriptors.documents.validatePdfData.path),
    validatePdfPath: lazyAsync(pathDescriptors.documents.validatePdfPath.path),
    openPdfInDefaultAppData: lazyAsync(pathDescriptors.documents.openPdfInDefaultAppData.path),
    openPdfInDefaultAppPath: lazyAsync(pathDescriptors.documents.openPdfInDefaultAppPath.path),
    printPdfData: lazyAsync(pathDescriptors.documents.printPdfData.path),
    printPdfPath: lazyAsync(pathDescriptors.documents.printPdfPath.path),
    writeFile: lazyAsync(pathDescriptors.documents.writeFile.path),
    replaceWorkingCopyFromPath: lazyAsync(pathDescriptors.documents.replaceWorkingCopyFromPath.path),
    writeDocxFile: lazyAsync(pathDescriptors.documents.writeDocxFile.path),
    createWorkingCopyFromData: lazyAsync(pathDescriptors.documents.createWorkingCopyFromData.path),
    createWorkingCopyFromPath: lazyAsync(pathDescriptors.documents.createWorkingCopyFromPath.path),
    saveFile: lazyAsync(pathDescriptors.documents.saveFile.path),
    savePdfData: lazyAsync(pathDescriptors.documents.savePdfData.path),
    savePdfDataChunks: lazyAsync(pathDescriptors.documents.savePdfDataChunks.path),
    cleanupFile: lazyAsync(pathDescriptors.documents.cleanupFile.path),
    cleanupOcrTemp: lazyAsync(pathDescriptors.documents.cleanupOcrTemp.path),
    setWindowTitle: lazyAsync(pathDescriptors.documents.setWindowTitle.path),
    showItemInFolder: lazyAsync(pathDescriptors.documents.showItemInFolder.path),
    recentFiles: {
        get: lazyAsync(pathDescriptors.documents.recentFiles.get.path),
        remove: lazyAsync(pathDescriptors.documents.recentFiles.remove.path),
        clear: lazyAsync(pathDescriptors.documents.recentFiles.clear.path),
    },
    getPathForFile(file) {
        return browserDocumentStore.getRefForFile(file);
    },
    getPathsForFiles(files) {
        return files.map(file => browserDocumentStore.getRefForFile(file));
    },
    setMenuDocumentState: lazyAsync(pathDescriptors.documents.setMenuDocumentState.path),
    setMenuTabCount: lazyAsync(pathDescriptors.documents.setMenuTabCount.path),
    onMenuOpenPdf: lazyEvent(pathDescriptors.documents.onMenuOpenPdf.path),
    onMenuInsertImageFromFile: lazyEvent(pathDescriptors.documents.onMenuInsertImageFromFile.path),
    onMenuPasteImageFromClipboard: lazyEvent(pathDescriptors.documents.onMenuPasteImageFromClipboard.path),
    onMenuSave: lazyEvent(pathDescriptors.documents.onMenuSave.path),
    onMenuRepairSave: lazyEvent(pathDescriptors.documents.onMenuRepairSave.path),
    onMenuOptimizePdfForInteraction: lazyEvent(pathDescriptors.documents.onMenuOptimizePdfForInteraction.path),
    onMenuSaveAs: lazyEvent(pathDescriptors.documents.onMenuSaveAs.path),
    onMenuPrint: lazyEvent(pathDescriptors.documents.onMenuPrint.path),
    onMenuPrintCurrentPage: lazyEvent(pathDescriptors.documents.onMenuPrintCurrentPage.path),
    onMenuExportDocx: lazyEvent(pathDescriptors.documents.onMenuExportDocx.path),
    onMenuExportImages: lazyEvent(pathDescriptors.documents.onMenuExportImages.path),
    onMenuExportMultiPageTiff: lazyEvent(pathDescriptors.documents.onMenuExportMultiPageTiff.path),
    onMenuZoomIn: lazyEvent(pathDescriptors.documents.onMenuZoomIn.path),
    onMenuZoomOut: lazyEvent(pathDescriptors.documents.onMenuZoomOut.path),
    onMenuActualSize: lazyEvent(pathDescriptors.documents.onMenuActualSize.path),
    onMenuFitWidth: lazyEvent(pathDescriptors.documents.onMenuFitWidth.path),
    onMenuFitHeight: lazyEvent(pathDescriptors.documents.onMenuFitHeight.path),
    onMenuViewModeSingle: lazyEvent(pathDescriptors.documents.onMenuViewModeSingle.path),
    onMenuViewModeFacing: lazyEvent(pathDescriptors.documents.onMenuViewModeFacing.path),
    onMenuViewModeFacingFirstSingle: lazyEvent(pathDescriptors.documents.onMenuViewModeFacingFirstSingle.path),
    onMenuToggleAssistant: lazyEvent(pathDescriptors.documents.onMenuToggleAssistant.path),
    onMenuUndo: lazyEvent(pathDescriptors.documents.onMenuUndo.path),
    onMenuRedo: lazyEvent(pathDescriptors.documents.onMenuRedo.path),
    onMenuDeletePages: lazyEvent(pathDescriptors.documents.onMenuDeletePages.path),
    onMenuExtractPages: lazyEvent(pathDescriptors.documents.onMenuExtractPages.path),
    onMenuRotateCw: lazyEvent(pathDescriptors.documents.onMenuRotateCw.path),
    onMenuRotateCcw: lazyEvent(pathDescriptors.documents.onMenuRotateCcw.path),
    onMenuInsertPages: lazyEvent(pathDescriptors.documents.onMenuInsertPages.path),
    onMenuOpenRecentFile: lazyEvent(pathDescriptors.documents.onMenuOpenRecentFile.path),
    onMenuOpenExternalPaths: lazyEvent(pathDescriptors.documents.onMenuOpenExternalPaths.path),
    onMenuClearRecentFiles: lazyEvent(pathDescriptors.documents.onMenuClearRecentFiles.path),
    onOpenDocumentDirectBatchProgress: lazyEvent(pathDescriptors.documents.onOpenDocumentDirectBatchProgress.path),
    onPdfOptimizeProgress: lazyEvent(pathDescriptors.documents.onPdfOptimizeProgress.path),
    onOpenPdfDirectBatchProgress: lazyEvent(pathDescriptors.documents.onOpenPdfDirectBatchProgress.path),
};

const lazyImageExportCapability: IImageExportCapability = {
    exportPdfToImages: lazyAsync(pathDescriptors.imageExport.exportPdfToImages.path),
    exportPdfToMultiPageTiff: lazyAsync(pathDescriptors.imageExport.exportPdfToMultiPageTiff.path),
    onProgress: lazyEvent(pathDescriptors.imageExport.onProgress.path),
};

const lazyPageOpsCapability: IPageOpsCapability = {
    delete: lazyAsync(pathDescriptors.pageOps.delete.path),
    extract: lazyAsync(pathDescriptors.pageOps.extract.path),
    reorder: lazyAsync(pathDescriptors.pageOps.reorder.path),
    insert: lazyAsync(pathDescriptors.pageOps.insert.path),
    insertFile: lazyAsync(pathDescriptors.pageOps.insertFile.path),
    rotate: lazyAsync(pathDescriptors.pageOps.rotate.path),
    crop: lazyAsync(pathDescriptors.pageOps.crop.path),
    removeCrop: lazyAsync(pathDescriptors.pageOps.removeCrop.path),
    getPageGeometry: lazyAsync(pathDescriptors.pageOps.getPageGeometry.path),
};

const lazyOcrCapability: IOcrCapability = {
    recognize: lazyAsync(pathDescriptors.ocr.recognize.path),
    recognizeBatch: lazyAsync(pathDescriptors.ocr.recognizeBatch.path),
    cancel: lazyAsync(pathDescriptors.ocr.cancel.path),
    getLanguages: lazyAsync(pathDescriptors.ocr.getLanguages.path),
    validateTools: lazyAsync(pathDescriptors.ocr.validateTools.path),
    installLanguages: lazyAsync(pathDescriptors.ocr.installLanguages.path),
    acknowledgeResultFile: lazyAsync(pathDescriptors.ocr.acknowledgeResultFile.path),
    createSearchablePdf: lazyAsync(pathDescriptors.ocr.createSearchablePdf.path),
    onProgress: lazyEvent(pathDescriptors.ocr.onProgress.path),
    onComplete: lazyEvent(pathDescriptors.ocr.onComplete.path),
    preprocessing: {
        validate: lazyAsync(pathDescriptors.ocr.preprocessing.validate.path),
        preprocessPage: lazyAsync(pathDescriptors.ocr.preprocessing.preprocessPage.path),
    },
};

const lazySearchCapability: ISearchCapability = {
    run: lazyAsync(pathDescriptors.search.run.path),
    warmIndex: lazyAsync(pathDescriptors.search.warmIndex.path),
    cancel: lazyAsync(pathDescriptors.search.cancel.path),
    onProgress: lazyEvent(pathDescriptors.search.onProgress.path),
    resetCache: lazyAsync(pathDescriptors.search.resetCache.path),
};

const lazyDjvuCapability: IDjvuCapability = {
    openForViewing: lazyAsync(pathDescriptors.djvu.openForViewing.path),
    releaseViewingPath: lazyAsync(pathDescriptors.djvu.releaseViewingPath.path),
    convertToPdf: lazyAsync(pathDescriptors.djvu.convertToPdf.path),
    cancel: lazyAsync(pathDescriptors.djvu.cancel.path),
    getInfo: lazyAsync(pathDescriptors.djvu.getInfo.path),
    getPageSizes: lazyAsync(pathDescriptors.djvu.getPageSizes.path),
    renderPagePreview: lazyAsync(pathDescriptors.djvu.renderPagePreview.path),
    estimateSizes: lazyAsync(pathDescriptors.djvu.estimateSizes.path),
    cleanupTemp: lazyAsync(pathDescriptors.djvu.cleanupTemp.path),
    onProgress: lazyEvent(pathDescriptors.djvu.onProgress.path),
    onViewingReady: lazyEvent(pathDescriptors.djvu.onViewingReady.path),
    onViewingError: lazyEvent(pathDescriptors.djvu.onViewingError.path),
    onMenuConvertToPdf: lazyEvent(pathDescriptors.djvu.onMenuConvertToPdf.path),
};

const lazySettingsCapability: ISettingsCapability = {
    get: lazyAsync(pathDescriptors.settings.get.path),
    save: lazyAsync(pathDescriptors.settings.save.path),
    getDebugLogs: lazyAsync(pathDescriptors.settings.getDebugLogs.path),
    onDebugLog: lazyEvent(pathDescriptors.settings.onDebugLog.path),
    rendererLog: lazyVoid(pathDescriptors.settings.rendererLog.path),
    onMenuOpenSettings: lazyEvent(pathDescriptors.settings.onMenuOpenSettings.path),
};

const lazyUpdatesCapability: IUpdatesCapability = {
    getState: lazyAsync(pathDescriptors.updates.getState.path),
    check: lazyAsync(pathDescriptors.updates.check.path),
    install: lazyAsync(pathDescriptors.updates.install.path),
    defer: lazyAsync(pathDescriptors.updates.defer.path),
    skipVersion: lazyAsync(pathDescriptors.updates.skipVersion.path),
    onStatus: lazyEvent(pathDescriptors.updates.onStatus.path),
    onMenuCheckForUpdates: lazyEvent(pathDescriptors.updates.onMenuCheckForUpdates.path),
};

const lazyWindowTabsCapability: IWindowTabsCapability = {
    transfer: lazyAsync(pathDescriptors.windowTabs.transfer.path),
    transferAck: lazyAsync(pathDescriptors.windowTabs.transferAck.path),
    listTargetWindows: lazyAsync(pathDescriptors.windowTabs.listTargetWindows.path),
    showContextMenu: lazyAsync(pathDescriptors.windowTabs.showContextMenu.path),
    onIncomingTransfer: lazyEvent(pathDescriptors.windowTabs.onIncomingTransfer.path),
    onWindowAction: lazyEvent(pathDescriptors.windowTabs.onWindowAction.path),
    closeCurrentWindow: lazyAsync(pathDescriptors.windowTabs.closeCurrentWindow.path),
    notifyRendererReady: lazyVoid(pathDescriptors.windowTabs.notifyRendererReady.path),
    claimPendingExternalOpenPaths: lazyAsync(pathDescriptors.windowTabs.claimPendingExternalOpenPaths.path),
    acknowledgePendingExternalOpenPaths: lazyAsync(pathDescriptors.windowTabs.acknowledgePendingExternalOpenPaths.path),
    onMenuNewTab: lazyEvent(pathDescriptors.windowTabs.onMenuNewTab.path),
    onMenuCloseTab: lazyEvent(pathDescriptors.windowTabs.onMenuCloseTab.path),
    onMenuSplitEditor: lazyEvent(pathDescriptors.windowTabs.onMenuSplitEditor.path),
    onMenuFocusEditorPane: lazyEvent(pathDescriptors.windowTabs.onMenuFocusEditorPane.path),
    onMenuMoveTabToPane: lazyEvent(pathDescriptors.windowTabs.onMenuMoveTabToPane.path),
    onMenuCopyTabToPane: lazyEvent(pathDescriptors.windowTabs.onMenuCopyTabToPane.path),
};

const lazyAgentCapability: IAgentCapability = {
    onWorkspaceSnapshotRequest: lazyEvent(pathDescriptors.agent.onWorkspaceSnapshotRequest.path),
    submitWorkspaceSnapshot: lazyAsync(pathDescriptors.agent.submitWorkspaceSnapshot.path),
    onCommandRequest: lazyEvent(pathDescriptors.agent.onCommandRequest.path),
    submitCommandResponse: lazyAsync(pathDescriptors.agent.submitCommandResponse.path),
    getMcpIntegrationStatus: lazyAsync(pathDescriptors.agent.getMcpIntegrationStatus.path),
    setMcpIntegrationEnabled: lazyAsync(pathDescriptors.agent.setMcpIntegrationEnabled.path),
    getAssistantState: lazyAsync(pathDescriptors.agent.getAssistantState.path),
    installAssistantCodex: lazyAsync(pathDescriptors.agent.installAssistantCodex.path),
    startAssistantLogin: lazyAsync(pathDescriptors.agent.startAssistantLogin.path),
    cancelAssistantLogin: lazyAsync(pathDescriptors.agent.cancelAssistantLogin.path),
    sendAssistantMessage: lazyAsync(pathDescriptors.agent.sendAssistantMessage.path),
    interruptAssistant: lazyAsync(pathDescriptors.agent.interruptAssistant.path),
    resetAssistantChat: lazyAsync(pathDescriptors.agent.resetAssistantChat.path),
    onAssistantEvent: lazyEvent(pathDescriptors.agent.onAssistantEvent.path),
};

const lazyShellCapability: IPlatformApi['shell'] = {openExternal: lazyAsync(pathDescriptors.shell.openExternal.path)};

const lazySystemCapability: ISystemCapability = { getMemoryInfo: () => null };

const lazyHostCapability: IHostCapability = {
    getEnvironment: lazyAsync(pathDescriptors.host.getEnvironment.path),
    onEnvironmentChange: lazyEvent(pathDescriptors.host.onEnvironmentChange.path),
    getZenModeState: lazyAsync(pathDescriptors.host.getZenModeState.path),
    setZenMode: lazyAsync(pathDescriptors.host.setZenMode.path),
    onZenModeChange: lazyEvent(pathDescriptors.host.onZenModeChange.path),
};

export const lazyBrowserPlatformApi = {
    documents: lazyDocumentsCapability,
    pageOps: lazyPageOpsCapability,
    imageExport: lazyImageExportCapability,
    ocr: lazyOcrCapability,
    search: lazySearchCapability,
    djvu: lazyDjvuCapability,
    settings: lazySettingsCapability,
    system: lazySystemCapability,
    updates: lazyUpdatesCapability,
    windowTabs: lazyWindowTabsCapability,
    shell: lazyShellCapability,
    host: lazyHostCapability,
    agent: lazyAgentCapability,
} satisfies IPlatformApi;
