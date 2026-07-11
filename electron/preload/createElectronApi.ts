import type {
    IpcRenderer,
    webUtils,
} from 'electron';
import type { IElectronAPI } from '@contracts/electronApi';
import { ELECTRON_PLATFORM_MANIFEST } from '@contracts/platformManifest';
import type {
    IDocumentsFileIoCapability,
    IDocumentsMenuCapability,
    IDocumentsOpenCapability,
    IDocumentsPdfCapability,
    IDocumentsPickerCapability,
    IDocumentsRecentFilesCapability,
    IDocumentsWindowCapability,
    IDocumentsWorkingCopyCapability,
} from '@contracts/electronApiDocuments';
import type { TMenuEventUnsubscribe } from '@contracts/electronApiCommon';
import { decodeHostEnvironmentSnapshot } from '@contracts/electronApiHost';
import { decodeAppUpdateStatus } from '@contracts/electronApiUpdates';
import {
    decodeWindowTabIncomingTransfer,
    decodeWindowTabsAction,
} from '@contracts/windowTabsValidation';
import { getDebugLogMessages } from '@electron/preload/debugLogBuffer';
import { decodeDebugLogEntry } from '@electron/preload/installDebugLogListener';
import { createAgentPreloadClient } from '@electron/features/agent/createAgentPreloadClient';
import {createDocumentsPreloadClient} from '@electron/features/documents/createDocumentsPreloadClient';
import { DOCUMENTS_IPC_CODECS } from '@electron/features/documents/documentsIpcCodecs';
import { createDocumentsPreloadPageOpsClient } from '@electron/features/documents/createDocumentsPreloadPageOpsClient';
import { createImageExportPreloadClient } from '@electron/features/image-export/createImageExportPreloadClient';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import {createOcrPreloadClient} from '@electron/features/ocr/createOcrPreloadClient';
import {createSearchPreloadClient} from '@electron/features/search/createSearchPreloadClient';
import {createDjvuPreloadClient} from '@electron/features/djvu/createDjvuPreloadClient';
import {
    createCodecIpcInvoker,
    createTypedIpcEventSubscriber,
} from '@electron/preload/ipcClient';
import { getErrorMessage } from '@electron/utils/error';
import {
    CORE_IPC_CHANNELS,
    CORE_IPC_EVENT_CHANNELS,
    CORE_IPC_SEND_CHANNELS,
    type ICoreEventMap,
    type ICoreInvokeMap,
    type IShutdownSaveFlushRequest,
    type IShutdownSaveFlushResult,
} from '@electron/platform-ipc/coreContract';
import { CORE_IPC_CODECS } from '@electron/platform-ipc/coreIpcCodecs';

const preloadStartupStart = Date.now();
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';

function stringifyDetails(details?: Record<string, unknown>) {
    if (!details) {
        return '';
    }

    try {
        return ` details=${JSON.stringify(details)}`;
    } catch {
        return ' details=<unserializable>';
    }
}

function tracePreloadStartup(stage: string, details?: Record<string, unknown>) {
    if (!STARTUP_TRACE_ENABLED) {
        return;
    }

    const now = Date.now();
    const iso = new Date(now).toISOString();
    console.info(
        `[${iso}] [startup][preload] ${stage} (+${now - preloadStartupStart}ms from preload-api-init)`
        + stringifyDetails(details),
    );
}

async function invokeWithStartupTrace<T>(label: string, invoke: () => Promise<T>) {
    const startedAt = Date.now();
    tracePreloadStartup(`${label}:start`);
    try {
        const result = await invoke();
        tracePreloadStartup(`${label}:ok`, {durationMs: Date.now() - startedAt});
        return result;
    } catch (error) {
        tracePreloadStartup(`${label}:error`, {
            durationMs: Date.now() - startedAt,
            error: getErrorMessage(error),
        });
        throw error;
    }
}

function readSystemMemoryInfo() {
    if (typeof process.getSystemMemoryInfo !== 'function') {
        return null;
    }

    const memoryInfo = process.getSystemMemoryInfo();
    const total = Number(memoryInfo.total);
    const free = Number(memoryInfo.free);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free) || free < 0) {
        return null;
    }

    return {
        totalBytes: Math.round(total * 1024),
        freeBytes: Math.round(free * 1024),
    };
}

export function createElectronApi(ipcRenderer: IpcRenderer, electronWebUtils: typeof webUtils): IElectronAPI {
    const invokeCore = createCodecIpcInvoker<ICoreInvokeMap>(ipcRenderer, CORE_IPC_CODECS);
    const invokeDocuments = createCodecIpcInvoker<IDocumentsInvokeMap>(ipcRenderer, DOCUMENTS_IPC_CODECS);
    const eventSubscriber = createTypedIpcEventSubscriber<ICoreEventMap>(ipcRenderer);
    const baseDocuments = createDocumentsPreloadClient(ipcRenderer);
    const pageOps = createDocumentsPreloadPageOpsClient(ipcRenderer);
    const imageExport = createImageExportPreloadClient(ipcRenderer);
    const shutdownSaveFlushCallbacks = new Set<() => Promise<{
        dirtyWorkingCopyPaths?: string[];
        flushedWorkingCopyPaths?: string[];
    }> | {
        dirtyWorkingCopyPaths?: string[];
        flushedWorkingCopyPaths?: string[];
    }>();
    const pendingRendererFileOpenAllows = new Map<string, {
        token: string;
        promise: Promise<boolean>;
    }>();

    function createRendererFileOpenAllow(filePath: string, rendererFileOpenToken = globalThis.crypto.randomUUID()) {
        const allowPromise = invokeDocuments(
            DOCUMENTS_CHANNELS.registerRendererFileOpenToken,
            rendererFileOpenToken,
        )
            .then(() => invokeDocuments(DOCUMENTS_CHANNELS.allowRendererFileOpen, {
                filePath,
                token: rendererFileOpenToken,
            }))
            .finally(() => {
                const pending = pendingRendererFileOpenAllows.get(filePath);
                if (pending?.token === rendererFileOpenToken) {
                    pendingRendererFileOpenAllows.delete(filePath);
                }
            });
        pendingRendererFileOpenAllows.set(filePath, {
            token: rendererFileOpenToken,
            promise: allowPromise,
        });
        return allowPromise;
    }

    function allowRendererFileOpen(filePath: string) {
        return createRendererFileOpenAllow(filePath);
    }

    function allowRendererFileOpenBatch(filePaths: string[]) {
        const uniqueFilePaths = [...new Set(filePaths.filter(Boolean))];
        if (uniqueFilePaths.length === 0) {
            return Promise.resolve(true);
        }
        const requests = uniqueFilePaths.map(filePath => ({
            filePath,
            token: globalThis.crypto.randomUUID(),
        }));
        const allowPromise = invokeDocuments(
            DOCUMENTS_CHANNELS.registerRendererFileOpenTokens,
            requests.map(request => request.token),
        )
            .then(registered => registered && invokeDocuments(DOCUMENTS_CHANNELS.allowRendererFileOpenBatch, requests))
            .finally(() => {
                for (const request of requests) {
                    const pending = pendingRendererFileOpenAllows.get(request.filePath);
                    if (pending?.token === request.token) {
                        pendingRendererFileOpenAllows.delete(request.filePath);
                    }
                }
            });
        for (const request of requests) {
            pendingRendererFileOpenAllows.set(request.filePath, {
                token: request.token,
                promise: allowPromise,
            });
        }
        return allowPromise;
    }

    function observeRendererFileOpenGrant(promise: Promise<boolean>, details: Record<string, unknown>) {
        promise.catch((error: unknown) => {
            tracePreloadStartup('renderer-file-open-grant:error', {
                ...details,
                error: getErrorMessage(error),
            });
            console.warn('Failed to authorize renderer file-open capability', {
                ...details,
                error: getErrorMessage(error),
            });
        });
    }

    const openDocumentDirect = async (path: string) => {
        const pendingAllow = pendingRendererFileOpenAllows.get(path)?.promise;
        if (pendingAllow && !await pendingAllow) {
            return null;
        }
        return baseDocuments.openDocumentDirect(path);
    };
    const openDocumentDirectBatch = async (
        paths: string[],
        requestId?: string,
        options?: {forceCombine?: boolean},
    ) => {
        const allowed = await Promise.all(paths.map(async (path) => {
            const pendingAllow = pendingRendererFileOpenAllows.get(path)?.promise;
            return pendingAllow === undefined || await pendingAllow;
        }));
        if (allowed.some(result => !result)) {
            return null;
        }
        return options === undefined
            ? baseDocuments.openDocumentDirectBatch(paths, requestId)
            : baseDocuments.openDocumentDirectBatch(paths, requestId, options);
    };

    const recentFiles = {
        ...baseDocuments.recentFiles,
        get: () => invokeWithStartupTrace('recentFiles:get', () => baseDocuments.recentFiles.get()),
    };
    const extractPathsForFiles = (files: File[]) => files
        .map(file => electronWebUtils.getPathForFile(file))
        .filter(filePath => filePath.length > 0);

    const getPathForFile = (file: File) => {
        const filePath = electronWebUtils.getPathForFile(file);
        if (filePath) {
            observeRendererFileOpenGrant(allowRendererFileOpen(filePath), { filePath });
        }
        return filePath;
    };
    const getPathsForFiles = (files: File[]) => {
        const filePaths = extractPathsForFiles(files);
        observeRendererFileOpenGrant(allowRendererFileOpenBatch(filePaths), { fileCount: filePaths.length });
        return filePaths;
    };
    const registerFilesForOpen = async (files: File[]) => {
        const filePaths = extractPathsForFiles(files);
        const allowed = await allowRendererFileOpenBatch(filePaths);
        return allowed ? filePaths : [];
    };

    ipcRenderer.on(CORE_IPC_EVENT_CHANNELS.shutdownSaveFlushRequest, (_event, payload: IShutdownSaveFlushRequest) => {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
        if (!requestId) {
            return;
        }
        void (async () => {
            const dirtyWorkingCopyPaths = new Set<string>();
            const flushedWorkingCopyPaths = new Set<string>();
            const errors: string[] = [];

            for (const callback of shutdownSaveFlushCallbacks) {
                try {
                    const result = await callback();
                    for (const path of result.dirtyWorkingCopyPaths ?? []) {
                        if (path) {
                            dirtyWorkingCopyPaths.add(path);
                        }
                    }
                    for (const path of result.flushedWorkingCopyPaths ?? []) {
                        if (path) {
                            flushedWorkingCopyPaths.add(path);
                        }
                    }
                } catch (error) {
                    errors.push(getErrorMessage(error));
                }
            }

            const response: IShutdownSaveFlushResult = {
                requestId,
                dirtyWorkingCopyPaths: Array.from(dirtyWorkingCopyPaths),
                flushedWorkingCopyPaths: Array.from(flushedWorkingCopyPaths),
                ...(errors.length > 0 ? {error: errors.join('; ')} : {}),
            };
            ipcRenderer.send(CORE_IPC_SEND_CHANNELS.shutdownSaveFlushResult, response);
        })();
    });

    const documentPicker = {
        openDocumentDialog: baseDocuments.openDocumentDialog,
        openPdfDialog: baseDocuments.openPdfDialog,
        openCombineDialog: baseDocuments.openCombineDialog,
        openFolderDialog: baseDocuments.openFolderDialog,
        ...(baseDocuments.openFolderDialogStructured
            ? {openFolderDialogStructured: baseDocuments.openFolderDialogStructured}
            : {}),
        openImageDialog: baseDocuments.openImageDialog,
        getPathForFile,
        getPathsForFiles,
        registerFilesForOpen,
        ...(baseDocuments.createCombinedPdfFromFiles
            ? {createCombinedPdfFromFiles: baseDocuments.createCombinedPdfFromFiles}
            : {}),
    } satisfies IDocumentsPickerCapability;
    const documentOpen = {
        openDocumentDirect,
        openPdfDirect: openDocumentDirect,
        openDocumentDirectBatch,
        openPdfDirectBatch: openDocumentDirectBatch,
        ...(baseDocuments.cancelOpenDocumentDirectBatch
            ? {cancelOpenDocumentDirectBatch: baseDocuments.cancelOpenDocumentDirectBatch}
            : {}),
    } satisfies IDocumentsOpenCapability;
    const documentWorkingCopy = {
        createWorkingCopyFromData: baseDocuments.createWorkingCopyFromData,
        createWorkingCopyFromPath: baseDocuments.createWorkingCopyFromPath,
        cleanupFile: baseDocuments.cleanupFile,
        cleanupOcrTemp: baseDocuments.cleanupOcrTemp,
    } satisfies IDocumentsWorkingCopyCapability;
    const optionalDocumentFileMethods = {
        ...(baseDocuments.repairPdf ? {repairPdf: baseDocuments.repairPdf} : {}),
        ...(baseDocuments.optimizePdfForInteraction ? {optimizePdfForInteraction: baseDocuments.optimizePdfForInteraction} : {}),
        ...(baseDocuments.optimizePdfAsCopy ? {optimizePdfAsCopy: baseDocuments.optimizePdfAsCopy} : {}),
        ...(baseDocuments.savePdfNoteTextUpdates ? {savePdfNoteTextUpdates: baseDocuments.savePdfNoteTextUpdates} : {}),
        ...(baseDocuments.savePdfNoteChanges ? {savePdfNoteChanges: baseDocuments.savePdfNoteChanges} : {}),
        ...(baseDocuments.savePdfNativeMutations ? {savePdfNativeMutations: baseDocuments.savePdfNativeMutations} : {}),
        ...(baseDocuments.applyPdfNativeMutationsToWorkingCopy
            ? {applyPdfNativeMutationsToWorkingCopy: baseDocuments.applyPdfNativeMutationsToWorkingCopy}
            : {}),
        ...(baseDocuments.commitStagedPdfNativeMutations
            ? {commitStagedPdfNativeMutations: baseDocuments.commitStagedPdfNativeMutations}
            : {}),
        ...(baseDocuments.getPdfNativePageSizes
            ? {getPdfNativePageSizes: baseDocuments.getPdfNativePageSizes}
            : {}),
        ...(baseDocuments.cancelPdfNativePagePreview
            ? {cancelPdfNativePagePreview: baseDocuments.cancelPdfNativePagePreview}
            : {}),
        ...(baseDocuments.renderPdfNativePagePreview
            ? {renderPdfNativePagePreview: baseDocuments.renderPdfNativePagePreview}
            : {}),
    };
    const documentFiles = {
        readFile: baseDocuments.readFile,
        statFile: baseDocuments.statFile,
        readFileRange: baseDocuments.readFileRange,
        readFileChunks: baseDocuments.readFileChunks,
        readTextFile: baseDocuments.readTextFile,
        fileExists: baseDocuments.fileExists,
        getDocumentRevision: baseDocuments.getDocumentRevision,
        onDocumentRevisionChanged: baseDocuments.onDocumentRevisionChanged,
        savePdfAs: baseDocuments.savePdfAs,
        savePdfDataAs: baseDocuments.savePdfDataAs,
        savePdfDialog: baseDocuments.savePdfDialog,
        saveDocxAs: baseDocuments.saveDocxAs,
        writeFile: baseDocuments.writeFile,
        replaceWorkingCopyFromPath: baseDocuments.replaceWorkingCopyFromPath,
        writeDocxFile: baseDocuments.writeDocxFile,
        saveFileStructured: baseDocuments.saveFileStructured,
        ...(baseDocuments.resyncWorkingCopy ? {resyncWorkingCopy: baseDocuments.resyncWorkingCopy} : {}),
        savePdfData: baseDocuments.savePdfData,
        savePdfDataChunks: baseDocuments.savePdfDataChunks,
        ...optionalDocumentFileMethods,
    } satisfies IDocumentsFileIoCapability;
    const documentPdf = {
        analyzePdfConformance: baseDocuments.analyzePdfConformance,
        validatePdfData: baseDocuments.validatePdfData,
        validatePdfPath: baseDocuments.validatePdfPath,
        openPdfInDefaultAppData: baseDocuments.openPdfInDefaultAppData,
        openPdfInDefaultAppPath: baseDocuments.openPdfInDefaultAppPath,
        printPdfData: baseDocuments.printPdfData,
        printPdfPath: baseDocuments.printPdfPath,
    } satisfies IDocumentsPdfCapability;
    const documentRecentFiles = {recentFiles} satisfies IDocumentsRecentFilesCapability;
    const documentWindow = {
        setWindowTitle: baseDocuments.setWindowTitle,
        showItemInFolder: baseDocuments.showItemInFolder,
        ...(baseDocuments.showItemInFolderStructured
            ? {showItemInFolderStructured: baseDocuments.showItemInFolderStructured}
            : {}),
    } satisfies IDocumentsWindowCapability;
    const documentMenu = {
        setMenuDocumentState: baseDocuments.setMenuDocumentState,
        setMenuTabCount: baseDocuments.setMenuTabCount,
        onPdfOptimizeProgress: baseDocuments.onPdfOptimizeProgress,
        onMenuOpenPdf: baseDocuments.onMenuOpenPdf,
        onMenuInsertImageFromFile: baseDocuments.onMenuInsertImageFromFile,
        onMenuPasteImageFromClipboard: baseDocuments.onMenuPasteImageFromClipboard,
        onMenuSave: baseDocuments.onMenuSave,
        onMenuRepairSave: baseDocuments.onMenuRepairSave,
        onMenuOptimizePdfForInteraction: baseDocuments.onMenuOptimizePdfForInteraction,
        onMenuSaveAs: baseDocuments.onMenuSaveAs,
        onMenuPrint: baseDocuments.onMenuPrint,
        onMenuPrintCurrentPage: baseDocuments.onMenuPrintCurrentPage,
        onMenuExportDocx: baseDocuments.onMenuExportDocx,
        onMenuExportImages: baseDocuments.onMenuExportImages,
        onMenuExportMultiPageTiff: baseDocuments.onMenuExportMultiPageTiff,
        onMenuZoomIn: baseDocuments.onMenuZoomIn,
        onMenuZoomOut: baseDocuments.onMenuZoomOut,
        onMenuActualSize: baseDocuments.onMenuActualSize,
        onMenuFitWidth: baseDocuments.onMenuFitWidth,
        onMenuFitHeight: baseDocuments.onMenuFitHeight,
        onMenuToggleContinuousScroll: baseDocuments.onMenuToggleContinuousScroll,
        onMenuViewModeSingle: baseDocuments.onMenuViewModeSingle,
        onMenuViewModeFacing: baseDocuments.onMenuViewModeFacing,
        onMenuViewModeFacingFirstSingle: baseDocuments.onMenuViewModeFacingFirstSingle,
        onMenuToggleAssistant: baseDocuments.onMenuToggleAssistant,
        onMenuUndo: baseDocuments.onMenuUndo,
        onMenuRedo: baseDocuments.onMenuRedo,
        onMenuDeletePages: baseDocuments.onMenuDeletePages,
        onMenuExtractPages: baseDocuments.onMenuExtractPages,
        onMenuRotateCw: baseDocuments.onMenuRotateCw,
        onMenuRotateCcw: baseDocuments.onMenuRotateCcw,
        onMenuInsertPages: baseDocuments.onMenuInsertPages,
        onMenuOpenRecentFile: baseDocuments.onMenuOpenRecentFile,
        onMenuOpenExternalPaths: baseDocuments.onMenuOpenExternalPaths,
        onMenuClearRecentFiles: baseDocuments.onMenuClearRecentFiles,
        onOpenDocumentDirectBatchProgress: baseDocuments.onOpenDocumentDirectBatchProgress,
        onOpenPdfDirectBatchProgress: baseDocuments.onOpenPdfDirectBatchProgress,
    } satisfies IDocumentsMenuCapability;

    const documents = {
        ...documentPicker,
        ...documentOpen,
        ...documentWorkingCopy,
        ...documentFiles,
        ...documentPdf,
        ...documentRecentFiles,
        ...documentWindow,
        ...documentMenu,
    };

    const api = {
        manifest: ELECTRON_PLATFORM_MANIFEST,
        documents,
        documentPicker,
        documentOpen,
        documentWorkingCopy,
        documentFiles,
        documentPdf,
        documentRecentFiles,
        documentWindow,
        documentMenu,
        pageOps,
        imageExport,

        ocr: createOcrPreloadClient(ipcRenderer),

        search: createSearchPreloadClient(ipcRenderer),

        djvu: createDjvuPreloadClient(ipcRenderer),

        settings: {
            get: () => invokeWithStartupTrace(
                'settings:get',
                () => invokeCore(CORE_IPC_CHANNELS.settingsGet),
            ),
            save: (settings) => invokeCore(CORE_IPC_CHANNELS.settingsSave, settings),
            getDebugLogs: () => Promise.resolve(getDebugLogMessages()),
            onDebugLog: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onDecodedPayload(CORE_IPC_EVENT_CHANNELS.debugLog, decodeDebugLogEntry, callback),
            rendererLog: (entry) => ipcRenderer.send(CORE_IPC_SEND_CHANNELS.rendererLog, entry),
            onMenuOpenSettings: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onNoArg(CORE_IPC_EVENT_CHANNELS.menuOpenSettings, callback),
        },

        system: {
            getMemoryInfo: readSystemMemoryInfo,
            onShutdownSaveFlushRequest: (callback) => {
                shutdownSaveFlushCallbacks.add(callback);
                return () => {
                    shutdownSaveFlushCallbacks.delete(callback);
                };
            },
        },

        updates: {
            getState: () => invokeCore(CORE_IPC_CHANNELS.updatesGetState),
            check: () => invokeCore(CORE_IPC_CHANNELS.updatesCheck),
            install: () => invokeCore(CORE_IPC_CHANNELS.updatesInstall),
            defer: () => invokeCore(CORE_IPC_CHANNELS.updatesDefer),
            skipVersion: (version) => invokeCore(CORE_IPC_CHANNELS.updatesSkipVersion, version),
            onStatus: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onDecodedPayload(
                    CORE_IPC_EVENT_CHANNELS.updatesStatus,
                    decodeAppUpdateStatus,
                    callback,
                ),
            onMenuCheckForUpdates: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onNoArg(CORE_IPC_EVENT_CHANNELS.menuCheckForUpdates, callback),
        },

        shell: {openExternal: (url) => invokeCore(CORE_IPC_CHANNELS.shellOpenExternal, url)},

        host: {
            getEnvironment: () => invokeCore(CORE_IPC_CHANNELS.hostGetEnvironment),
            onEnvironmentChange: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onDecodedPayload(
                    CORE_IPC_EVENT_CHANNELS.hostEnvironmentChanged,
                    decodeHostEnvironmentSnapshot,
                    callback,
                ),
            getZenModeState: () => invokeCore(CORE_IPC_CHANNELS.hostGetZenModeState),
            setZenMode: (active) => invokeCore(CORE_IPC_CHANNELS.hostSetZenMode, active),
            onZenModeChange: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayloadUnchecked(CORE_IPC_EVENT_CHANNELS.hostZenModeChanged, callback),
        },

        agent: createAgentPreloadClient(ipcRenderer),

        windowTabs: {
            closeCurrentWindow: () => invokeCore(CORE_IPC_CHANNELS.windowCloseCurrent),
            notifyRendererReady: () => {
                tracePreloadStartup('app:rendererReady dispatched');
                ipcRenderer.send(CORE_IPC_CHANNELS.rendererReady);
            },
            claimPendingExternalOpenPaths: () => invokeWithStartupTrace(
                'app:claimPendingExternalOpenPaths',
                () => invokeCore(CORE_IPC_CHANNELS.claimPendingExternalOpenPaths),
            ),
            acknowledgePendingExternalOpenPaths: (failedPaths) => invokeCore(
                CORE_IPC_CHANNELS.acknowledgePendingExternalOpenPaths,
                failedPaths,
            ),
            saveWorkspaceCheckpoint: checkpoint => invokeCore(
                CORE_IPC_CHANNELS.workspaceCheckpointSave,
                checkpoint,
            ),
            claimWorkspaceCheckpoint: () => invokeCore(CORE_IPC_CHANNELS.workspaceCheckpointClaim),
            transfer: (request) => invokeCore(CORE_IPC_CHANNELS.tabsTransfer, request),
            transferAck: (ack) => invokeCore(CORE_IPC_CHANNELS.tabsTransferAck, ack),
            listTargetWindows: () => invokeCore(CORE_IPC_CHANNELS.tabsListTargets),
            showContextMenu: (tabId) => invokeCore(CORE_IPC_CHANNELS.tabsShowContextMenu, tabId),
            onIncomingTransfer: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onDecodedPayload(
                    CORE_IPC_EVENT_CHANNELS.tabsIncomingTransfer,
                    decodeWindowTabIncomingTransfer,
                    callback,
                ),
            onWindowAction: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onDecodedPayload(
                    CORE_IPC_EVENT_CHANNELS.menuWindowTabsAction,
                    decodeWindowTabsAction,
                    callback,
                ),
            onMenuNewTab: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onNoArg(CORE_IPC_EVENT_CHANNELS.menuNewTab, callback),
            onMenuCloseTab: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onNoArg(CORE_IPC_EVENT_CHANNELS.menuCloseTab, callback),
            onMenuSplitEditor: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayloadUnchecked(CORE_IPC_EVENT_CHANNELS.menuSplitEditor, callback),
            onMenuFocusEditorPane: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayloadUnchecked(CORE_IPC_EVENT_CHANNELS.menuFocusEditorPane, callback),
            onMenuMoveTabToPane: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayloadUnchecked(CORE_IPC_EVENT_CHANNELS.menuMoveTabToPane, callback),
            onMenuCopyTabToPane: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayloadUnchecked(CORE_IPC_EVENT_CHANNELS.menuCopyTabToPane, callback),
        },
    } satisfies IElectronAPI;

    return api;
}
