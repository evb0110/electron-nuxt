import {isRecord} from '@contracts/runtimeGuards';
import type { IPlatformApi } from '@contracts/platformApi';

type TCapabilityKey = keyof IPlatformApi;
type TCallablePlatformMember<TMember> =
    NonNullable<TMember> extends (...args: infer TArgs) => infer TResult
        ? (...args: TArgs) => TResult
        : never;

type TCallableMemberKey<TTarget> = Extract<{
    [TKey in keyof NonNullable<TTarget>]: TCallablePlatformMember<NonNullable<TTarget>[TKey]> extends never
        ? never
        : TKey;
}[keyof NonNullable<TTarget>], string>;

type TObjectMemberKey<TTarget> = Extract<{
    [TKey in keyof NonNullable<TTarget>]: TCallablePlatformMember<NonNullable<TTarget>[TKey]> extends never
        ? NonNullable<NonNullable<TTarget>[TKey]> extends object
            ? TKey
            : never
        : never;
}[keyof NonNullable<TTarget>], string>;

export type TBrowserPlatformMethodPath = {
    [TKey in TCapabilityKey]: readonly [
        TKey,
        TCallableMemberKey<IPlatformApi[TKey]>,
    ];
}[TCapabilityKey] | {
    [TKey in TCapabilityKey]: {
        [TOwnerKey in TObjectMemberKey<IPlatformApi[TKey]>]: readonly [
            TKey,
            TOwnerKey,
            TCallableMemberKey<NonNullable<NonNullable<IPlatformApi[TKey]>[TOwnerKey]>>,
        ];
    }[TObjectMemberKey<IPlatformApi[TKey]>];
}[TCapabilityKey];

export type TMethodAtBrowserPlatformPath<TPath extends TBrowserPlatformMethodPath> =
    TPath extends readonly [infer TCapabilityKey, infer TMethodKey]
        ? TCapabilityKey extends keyof IPlatformApi
            ? TMethodKey extends keyof NonNullable<IPlatformApi[TCapabilityKey]>
                ? TCallablePlatformMember<NonNullable<IPlatformApi[TCapabilityKey]>[TMethodKey]>
                : never
            : never
        : TPath extends readonly [infer TCapabilityKey, infer TOwnerKey, infer TMethodKey]
            ? TCapabilityKey extends keyof IPlatformApi
                ? TOwnerKey extends keyof NonNullable<IPlatformApi[TCapabilityKey]>
                    ? TMethodKey extends keyof NonNullable<NonNullable<IPlatformApi[TCapabilityKey]>[TOwnerKey]>
                        ? TCallablePlatformMember<NonNullable<NonNullable<IPlatformApi[TCapabilityKey]>[TOwnerKey]>[TMethodKey]>
                        : never
                    : never
                : never
            : never;

export type TBrowserPlatformAsyncMethodPath = TBrowserPlatformMethodPath;
export type TBrowserPlatformEventMethodPath = TBrowserPlatformMethodPath;
export type TBrowserPlatformVoidMethodPath = TBrowserPlatformMethodPath;

type TBrowserPlatformPathDescriptor =
    | {
        kind: 'async';
        path: TBrowserPlatformAsyncMethodPath;
    }
    | {
        kind: 'event';
        path: TBrowserPlatformEventMethodPath;
    }
    | {
        kind: 'void';
        path: TBrowserPlatformVoidMethodPath;
    };

function asyncPath<const TPath extends TBrowserPlatformAsyncMethodPath>(...path: TPath) {
    return {
        kind: 'async',
        path,
    } as const;
}

function eventPath<const TPath extends TBrowserPlatformEventMethodPath>(...path: TPath) {
    return {
        kind: 'event',
        path,
    } as const;
}

function voidPath<const TPath extends TBrowserPlatformVoidMethodPath>(...path: TPath) {
    return {
        kind: 'void',
        path,
    } as const;
}


function isBrowserPlatformPathDescriptor(value: unknown): value is TBrowserPlatformPathDescriptor {
    return isRecord(value)
        && (value.kind === 'async' || value.kind === 'event' || value.kind === 'void')
        && Array.isArray(value.path);
}

function collectBrowserPlatformPathDescriptors(
    value: unknown,
    descriptors: TBrowserPlatformPathDescriptor[] = [],
) {
    if (isBrowserPlatformPathDescriptor(value)) {
        descriptors.push(value);
        return descriptors;
    }
    if (!isRecord(value)) {
        return descriptors;
    }
    for (const child of Object.values(value)) {
        collectBrowserPlatformPathDescriptors(child, descriptors);
    }
    return descriptors;
}

export const browserPlatformPathDescriptors = {
    documentPicker: {
        openDocumentDialog: asyncPath('documentPicker', 'openDocumentDialog'),
        openPdfDialog: asyncPath('documentPicker', 'openPdfDialog'),
        openCombineDialog: asyncPath('documentPicker', 'openCombineDialog'),
        openFolderDialog: asyncPath('documentPicker', 'openFolderDialog'),
        openImageDialog: asyncPath('documentPicker', 'openImageDialog'),
    },
    documentOpen: {
        openDocumentDirect: asyncPath('documentOpen', 'openDocumentDirect'),
        openPdfDirect: asyncPath('documentOpen', 'openPdfDirect'),
        openDocumentDirectBatch: asyncPath('documentOpen', 'openDocumentDirectBatch'),
        openPdfDirectBatch: asyncPath('documentOpen', 'openPdfDirectBatch'),
    },
    documentWorkingCopy: {
        createWorkingCopyFromData: asyncPath('documentWorkingCopy', 'createWorkingCopyFromData'),
        createWorkingCopyFromPath: asyncPath('documentWorkingCopy', 'createWorkingCopyFromPath'),
        cleanupFile: asyncPath('documentWorkingCopy', 'cleanupFile'),
        cleanupOcrTemp: asyncPath('documentWorkingCopy', 'cleanupOcrTemp'),
    },
    documentFiles: {
        readFile: asyncPath('documentFiles', 'readFile'),
        statFile: asyncPath('documentFiles', 'statFile'),
        readFileRange: asyncPath('documentFiles', 'readFileRange'),
        readFileChunks: asyncPath('documentFiles', 'readFileChunks'),
        readTextFile: asyncPath('documentFiles', 'readTextFile'),
        fileExists: asyncPath('documentFiles', 'fileExists'),
        savePdfAs: asyncPath('documentFiles', 'savePdfAs'),
        savePdfDataAs: asyncPath('documentFiles', 'savePdfDataAs'),
        savePdfDialog: asyncPath('documentFiles', 'savePdfDialog'),
        saveDocxAs: asyncPath('documentFiles', 'saveDocxAs'),
        writeFile: asyncPath('documentFiles', 'writeFile'),
        replaceWorkingCopyFromPath: asyncPath('documentFiles', 'replaceWorkingCopyFromPath'),
        writeDocxFile: asyncPath('documentFiles', 'writeDocxFile'),
        saveFile: asyncPath('documentFiles', 'saveFile'),
        savePdfData: asyncPath('documentFiles', 'savePdfData'),
        savePdfDataChunks: asyncPath('documentFiles', 'savePdfDataChunks'),
    },
    documentPdf: {
        analyzePdfConformance: asyncPath('documentPdf', 'analyzePdfConformance'),
        validatePdfData: asyncPath('documentPdf', 'validatePdfData'),
        validatePdfPath: asyncPath('documentPdf', 'validatePdfPath'),
        openPdfInDefaultAppData: asyncPath('documentPdf', 'openPdfInDefaultAppData'),
        openPdfInDefaultAppPath: asyncPath('documentPdf', 'openPdfInDefaultAppPath'),
        printPdfData: asyncPath('documentPdf', 'printPdfData'),
        printPdfPath: asyncPath('documentPdf', 'printPdfPath'),
    },
    documentRecentFiles: {recentFiles: {
        get: asyncPath('documentRecentFiles', 'recentFiles', 'get'),
        remove: asyncPath('documentRecentFiles', 'recentFiles', 'remove'),
        clear: asyncPath('documentRecentFiles', 'recentFiles', 'clear'),
    }},
    documentWindow: {
        setWindowTitle: asyncPath('documentWindow', 'setWindowTitle'),
        showItemInFolder: asyncPath('documentWindow', 'showItemInFolder'),
    },
    documentMenu: {
        setMenuDocumentState: asyncPath('documentMenu', 'setMenuDocumentState'),
        setMenuTabCount: asyncPath('documentMenu', 'setMenuTabCount'),
        onMenuOpenPdf: eventPath('documentMenu', 'onMenuOpenPdf'),
        onMenuInsertImageFromFile: eventPath('documentMenu', 'onMenuInsertImageFromFile'),
        onMenuPasteImageFromClipboard: eventPath('documentMenu', 'onMenuPasteImageFromClipboard'),
        onMenuSave: eventPath('documentMenu', 'onMenuSave'),
        onMenuRepairSave: eventPath('documentMenu', 'onMenuRepairSave'),
        onMenuOptimizePdfForInteraction: eventPath('documentMenu', 'onMenuOptimizePdfForInteraction'),
        onMenuSaveAs: eventPath('documentMenu', 'onMenuSaveAs'),
        onMenuPrint: eventPath('documentMenu', 'onMenuPrint'),
        onMenuPrintCurrentPage: eventPath('documentMenu', 'onMenuPrintCurrentPage'),
        onMenuExportDocx: eventPath('documentMenu', 'onMenuExportDocx'),
        onMenuExportImages: eventPath('documentMenu', 'onMenuExportImages'),
        onMenuExportMultiPageTiff: eventPath('documentMenu', 'onMenuExportMultiPageTiff'),
        onMenuZoomIn: eventPath('documentMenu', 'onMenuZoomIn'),
        onMenuZoomOut: eventPath('documentMenu', 'onMenuZoomOut'),
        onMenuActualSize: eventPath('documentMenu', 'onMenuActualSize'),
        onMenuFitWidth: eventPath('documentMenu', 'onMenuFitWidth'),
        onMenuFitHeight: eventPath('documentMenu', 'onMenuFitHeight'),
        onMenuViewModeSingle: eventPath('documentMenu', 'onMenuViewModeSingle'),
        onMenuViewModeFacing: eventPath('documentMenu', 'onMenuViewModeFacing'),
        onMenuViewModeFacingFirstSingle: eventPath('documentMenu', 'onMenuViewModeFacingFirstSingle'),
        onMenuToggleAssistant: eventPath('documentMenu', 'onMenuToggleAssistant'),
        onMenuUndo: eventPath('documentMenu', 'onMenuUndo'),
        onMenuRedo: eventPath('documentMenu', 'onMenuRedo'),
        onMenuDeletePages: eventPath('documentMenu', 'onMenuDeletePages'),
        onMenuExtractPages: eventPath('documentMenu', 'onMenuExtractPages'),
        onMenuRotateCw: eventPath('documentMenu', 'onMenuRotateCw'),
        onMenuRotateCcw: eventPath('documentMenu', 'onMenuRotateCcw'),
        onMenuInsertPages: eventPath('documentMenu', 'onMenuInsertPages'),
        onMenuOpenRecentFile: eventPath('documentMenu', 'onMenuOpenRecentFile'),
        onMenuOpenExternalPaths: eventPath('documentMenu', 'onMenuOpenExternalPaths'),
        onMenuClearRecentFiles: eventPath('documentMenu', 'onMenuClearRecentFiles'),
        onOpenDocumentDirectBatchProgress: eventPath('documentMenu', 'onOpenDocumentDirectBatchProgress'),
        onPdfOptimizeProgress: eventPath('documentMenu', 'onPdfOptimizeProgress'),
        onOpenPdfDirectBatchProgress: eventPath('documentMenu', 'onOpenPdfDirectBatchProgress'),
    },
    documents: {
        openDocumentDialog: asyncPath('documents', 'openDocumentDialog'),
        openPdfDialog: asyncPath('documents', 'openPdfDialog'),
        openCombineDialog: asyncPath('documents', 'openCombineDialog'),
        openFolderDialog: asyncPath('documents', 'openFolderDialog'),
        openImageDialog: asyncPath('documents', 'openImageDialog'),
        openDocumentDirect: asyncPath('documents', 'openDocumentDirect'),
        openPdfDirect: asyncPath('documents', 'openPdfDirect'),
        openDocumentDirectBatch: asyncPath('documents', 'openDocumentDirectBatch'),
        openPdfDirectBatch: asyncPath('documents', 'openPdfDirectBatch'),
        savePdfAs: asyncPath('documents', 'savePdfAs'),
        savePdfDataAs: asyncPath('documents', 'savePdfDataAs'),
        savePdfDialog: asyncPath('documents', 'savePdfDialog'),
        saveDocxAs: asyncPath('documents', 'saveDocxAs'),
        readFile: asyncPath('documents', 'readFile'),
        statFile: asyncPath('documents', 'statFile'),
        readFileRange: asyncPath('documents', 'readFileRange'),
        readFileChunks: asyncPath('documents', 'readFileChunks'),
        readTextFile: asyncPath('documents', 'readTextFile'),
        fileExists: asyncPath('documents', 'fileExists'),
        analyzePdfConformance: asyncPath('documents', 'analyzePdfConformance'),
        validatePdfData: asyncPath('documents', 'validatePdfData'),
        validatePdfPath: asyncPath('documents', 'validatePdfPath'),
        openPdfInDefaultAppData: asyncPath('documents', 'openPdfInDefaultAppData'),
        openPdfInDefaultAppPath: asyncPath('documents', 'openPdfInDefaultAppPath'),
        printPdfData: asyncPath('documents', 'printPdfData'),
        printPdfPath: asyncPath('documents', 'printPdfPath'),
        writeFile: asyncPath('documents', 'writeFile'),
        replaceWorkingCopyFromPath: asyncPath('documents', 'replaceWorkingCopyFromPath'),
        writeDocxFile: asyncPath('documents', 'writeDocxFile'),
        createWorkingCopyFromData: asyncPath('documents', 'createWorkingCopyFromData'),
        createWorkingCopyFromPath: asyncPath('documents', 'createWorkingCopyFromPath'),
        saveFile: asyncPath('documents', 'saveFile'),
        savePdfData: asyncPath('documents', 'savePdfData'),
        savePdfDataChunks: asyncPath('documents', 'savePdfDataChunks'),
        cleanupFile: asyncPath('documents', 'cleanupFile'),
        cleanupOcrTemp: asyncPath('documents', 'cleanupOcrTemp'),
        setWindowTitle: asyncPath('documents', 'setWindowTitle'),
        showItemInFolder: asyncPath('documents', 'showItemInFolder'),
        recentFiles: {
            get: asyncPath('documents', 'recentFiles', 'get'),
            remove: asyncPath('documents', 'recentFiles', 'remove'),
            clear: asyncPath('documents', 'recentFiles', 'clear'),
        },
        setMenuDocumentState: asyncPath('documents', 'setMenuDocumentState'),
        setMenuTabCount: asyncPath('documents', 'setMenuTabCount'),
        onMenuOpenPdf: eventPath('documents', 'onMenuOpenPdf'),
        onMenuInsertImageFromFile: eventPath('documents', 'onMenuInsertImageFromFile'),
        onMenuPasteImageFromClipboard: eventPath('documents', 'onMenuPasteImageFromClipboard'),
        onMenuSave: eventPath('documents', 'onMenuSave'),
        onMenuRepairSave: eventPath('documents', 'onMenuRepairSave'),
        onMenuOptimizePdfForInteraction: eventPath('documents', 'onMenuOptimizePdfForInteraction'),
        onMenuSaveAs: eventPath('documents', 'onMenuSaveAs'),
        onMenuPrint: eventPath('documents', 'onMenuPrint'),
        onMenuPrintCurrentPage: eventPath('documents', 'onMenuPrintCurrentPage'),
        onMenuExportDocx: eventPath('documents', 'onMenuExportDocx'),
        onMenuExportImages: eventPath('documents', 'onMenuExportImages'),
        onMenuExportMultiPageTiff: eventPath('documents', 'onMenuExportMultiPageTiff'),
        onMenuZoomIn: eventPath('documents', 'onMenuZoomIn'),
        onMenuZoomOut: eventPath('documents', 'onMenuZoomOut'),
        onMenuActualSize: eventPath('documents', 'onMenuActualSize'),
        onMenuFitWidth: eventPath('documents', 'onMenuFitWidth'),
        onMenuFitHeight: eventPath('documents', 'onMenuFitHeight'),
        onMenuViewModeSingle: eventPath('documents', 'onMenuViewModeSingle'),
        onMenuViewModeFacing: eventPath('documents', 'onMenuViewModeFacing'),
        onMenuViewModeFacingFirstSingle: eventPath('documents', 'onMenuViewModeFacingFirstSingle'),
        onMenuToggleAssistant: eventPath('documents', 'onMenuToggleAssistant'),
        onMenuUndo: eventPath('documents', 'onMenuUndo'),
        onMenuRedo: eventPath('documents', 'onMenuRedo'),
        onMenuDeletePages: eventPath('documents', 'onMenuDeletePages'),
        onMenuExtractPages: eventPath('documents', 'onMenuExtractPages'),
        onMenuRotateCw: eventPath('documents', 'onMenuRotateCw'),
        onMenuRotateCcw: eventPath('documents', 'onMenuRotateCcw'),
        onMenuInsertPages: eventPath('documents', 'onMenuInsertPages'),
        onMenuOpenRecentFile: eventPath('documents', 'onMenuOpenRecentFile'),
        onMenuOpenExternalPaths: eventPath('documents', 'onMenuOpenExternalPaths'),
        onMenuClearRecentFiles: eventPath('documents', 'onMenuClearRecentFiles'),
        onOpenDocumentDirectBatchProgress: eventPath('documents', 'onOpenDocumentDirectBatchProgress'),
        onPdfOptimizeProgress: eventPath('documents', 'onPdfOptimizeProgress'),
        onOpenPdfDirectBatchProgress: eventPath('documents', 'onOpenPdfDirectBatchProgress'),
    },
    imageExport: {
        exportPdfToImages: asyncPath('imageExport', 'exportPdfToImages'),
        exportPdfToMultiPageTiff: asyncPath('imageExport', 'exportPdfToMultiPageTiff'),
        onProgress: eventPath('imageExport', 'onProgress'),
    },
    pageOps: {
        delete: asyncPath('pageOps', 'delete'),
        extract: asyncPath('pageOps', 'extract'),
        reorder: asyncPath('pageOps', 'reorder'),
        insert: asyncPath('pageOps', 'insert'),
        insertFile: asyncPath('pageOps', 'insertFile'),
        rotate: asyncPath('pageOps', 'rotate'),
        crop: asyncPath('pageOps', 'crop'),
        removeCrop: asyncPath('pageOps', 'removeCrop'),
        getPageGeometry: asyncPath('pageOps', 'getPageGeometry'),
    },
    ocr: {
        recognize: asyncPath('ocr', 'recognize'),
        recognizeBatch: asyncPath('ocr', 'recognizeBatch'),
        cancel: asyncPath('ocr', 'cancel'),
        getLanguages: asyncPath('ocr', 'getLanguages'),
        validateTools: asyncPath('ocr', 'validateTools'),
        installLanguages: asyncPath('ocr', 'installLanguages'),
        acknowledgeResultFile: asyncPath('ocr', 'acknowledgeResultFile'),
        createSearchablePdf: asyncPath('ocr', 'createSearchablePdf'),
        onProgress: eventPath('ocr', 'onProgress'),
        onComplete: eventPath('ocr', 'onComplete'),
        preprocessing: {
            validate: asyncPath('ocr', 'preprocessing', 'validate'),
            preprocessPage: asyncPath('ocr', 'preprocessing', 'preprocessPage'),
        },
    },
    search: {
        run: asyncPath('search', 'run'),
        warmIndex: asyncPath('search', 'warmIndex'),
        cancel: asyncPath('search', 'cancel'),
        onProgress: eventPath('search', 'onProgress'),
        resetCache: asyncPath('search', 'resetCache'),
    },
    djvu: {
        openForViewing: asyncPath('djvu', 'openForViewing'),
        releaseViewingPath: asyncPath('djvu', 'releaseViewingPath'),
        convertToPdf: asyncPath('djvu', 'convertToPdf'),
        cancel: asyncPath('djvu', 'cancel'),
        getInfo: asyncPath('djvu', 'getInfo'),
        getPageSizes: asyncPath('djvu', 'getPageSizes'),
        renderPagePreview: asyncPath('djvu', 'renderPagePreview'),
        estimateSizes: asyncPath('djvu', 'estimateSizes'),
        cleanupTemp: asyncPath('djvu', 'cleanupTemp'),
        onProgress: eventPath('djvu', 'onProgress'),
        onViewingReady: eventPath('djvu', 'onViewingReady'),
        onViewingError: eventPath('djvu', 'onViewingError'),
        onMenuConvertToPdf: eventPath('djvu', 'onMenuConvertToPdf'),
    },
    settings: {
        get: asyncPath('settings', 'get'),
        save: asyncPath('settings', 'save'),
        getDebugLogs: asyncPath('settings', 'getDebugLogs'),
        onDebugLog: eventPath('settings', 'onDebugLog'),
        rendererLog: voidPath('settings', 'rendererLog'),
        onMenuOpenSettings: eventPath('settings', 'onMenuOpenSettings'),
    },
    updates: {
        getState: asyncPath('updates', 'getState'),
        check: asyncPath('updates', 'check'),
        install: asyncPath('updates', 'install'),
        defer: asyncPath('updates', 'defer'),
        skipVersion: asyncPath('updates', 'skipVersion'),
        onStatus: eventPath('updates', 'onStatus'),
        onMenuCheckForUpdates: eventPath('updates', 'onMenuCheckForUpdates'),
    },
    windowTabs: {
        transfer: asyncPath('windowTabs', 'transfer'),
        transferAck: asyncPath('windowTabs', 'transferAck'),
        listTargetWindows: asyncPath('windowTabs', 'listTargetWindows'),
        showContextMenu: asyncPath('windowTabs', 'showContextMenu'),
        onIncomingTransfer: eventPath('windowTabs', 'onIncomingTransfer'),
        onWindowAction: eventPath('windowTabs', 'onWindowAction'),
        closeCurrentWindow: asyncPath('windowTabs', 'closeCurrentWindow'),
        notifyRendererReady: voidPath('windowTabs', 'notifyRendererReady'),
        claimPendingExternalOpenPaths: asyncPath('windowTabs', 'claimPendingExternalOpenPaths'),
        acknowledgePendingExternalOpenPaths: asyncPath('windowTabs', 'acknowledgePendingExternalOpenPaths'),
        onMenuNewTab: eventPath('windowTabs', 'onMenuNewTab'),
        onMenuCloseTab: eventPath('windowTabs', 'onMenuCloseTab'),
        onMenuSplitEditor: eventPath('windowTabs', 'onMenuSplitEditor'),
        onMenuFocusEditorPane: eventPath('windowTabs', 'onMenuFocusEditorPane'),
        onMenuMoveTabToPane: eventPath('windowTabs', 'onMenuMoveTabToPane'),
        onMenuCopyTabToPane: eventPath('windowTabs', 'onMenuCopyTabToPane'),
    },
    agent: {
        onWorkspaceSnapshotRequest: eventPath('agent', 'onWorkspaceSnapshotRequest'),
        submitWorkspaceSnapshot: asyncPath('agent', 'submitWorkspaceSnapshot'),
        onCommandRequest: eventPath('agent', 'onCommandRequest'),
        submitCommandResponse: asyncPath('agent', 'submitCommandResponse'),
        getMcpIntegrationStatus: asyncPath('agent', 'getMcpIntegrationStatus'),
        setMcpIntegrationEnabled: asyncPath('agent', 'setMcpIntegrationEnabled'),
        getAssistantState: asyncPath('agent', 'getAssistantState'),
        installAssistantCodex: asyncPath('agent', 'installAssistantCodex'),
        startAssistantLogin: asyncPath('agent', 'startAssistantLogin'),
        cancelAssistantLogin: asyncPath('agent', 'cancelAssistantLogin'),
        sendAssistantMessage: asyncPath('agent', 'sendAssistantMessage'),
        interruptAssistant: asyncPath('agent', 'interruptAssistant'),
        resetAssistantChat: asyncPath('agent', 'resetAssistantChat'),
        onAssistantEvent: eventPath('agent', 'onAssistantEvent'),
    },
    shell: {openExternal: asyncPath('shell', 'openExternal')},
    host: {
        getEnvironment: asyncPath('host', 'getEnvironment'),
        onEnvironmentChange: eventPath('host', 'onEnvironmentChange'),
        getZenModeState: asyncPath('host', 'getZenModeState'),
        setZenMode: asyncPath('host', 'setZenMode'),
        onZenModeChange: eventPath('host', 'onZenModeChange'),
    },
} as const;

export const directBrowserPlatformMemberPaths = [
    [
        'documentPicker',
        'getPathForFile',
    ],
    [
        'documentPicker',
        'getPathsForFiles',
    ],
    [
        'documents',
        'getPathForFile',
    ],
    [
        'documents',
        'getPathsForFiles',
    ],
    [
        'system',
        'getMemoryInfo',
    ],
] as const satisfies readonly TBrowserPlatformMethodPath[];

export const browserPlatformPathDescriptorList = collectBrowserPlatformPathDescriptors(
    browserPlatformPathDescriptors,
);
