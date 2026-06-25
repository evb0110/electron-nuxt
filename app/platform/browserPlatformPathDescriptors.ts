import type { IPlatformApi } from '@contracts/platformApi';

type TCapabilityKey = keyof IPlatformApi;
type TCallablePlatformMember<TMember> =
    NonNullable<TMember> extends (...args: infer TArgs) => infer TResult
        ? (...args: TArgs) => TResult
        : never;

type TCallableMemberKey<TTarget> = Extract<{
    [TKey in keyof TTarget]: TCallablePlatformMember<TTarget[TKey]> extends never
        ? never
        : TKey;
}[keyof TTarget], string>;

type TObjectMemberKey<TTarget> = Extract<{
    [TKey in keyof TTarget]: TCallablePlatformMember<TTarget[TKey]> extends never
        ? NonNullable<TTarget[TKey]> extends object
            ? TKey
            : never
        : never;
}[keyof TTarget], string>;

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
            TCallableMemberKey<NonNullable<IPlatformApi[TKey][TOwnerKey]>>,
        ];
    }[TObjectMemberKey<IPlatformApi[TKey]>];
}[TCapabilityKey];

export type TMethodAtBrowserPlatformPath<TPath extends TBrowserPlatformMethodPath> =
    TPath extends readonly [infer TCapabilityKey, infer TMethodKey]
        ? TCapabilityKey extends keyof IPlatformApi
            ? TMethodKey extends keyof IPlatformApi[TCapabilityKey]
                ? TCallablePlatformMember<IPlatformApi[TCapabilityKey][TMethodKey]>
                : never
            : never
        : TPath extends readonly [infer TCapabilityKey, infer TOwnerKey, infer TMethodKey]
            ? TCapabilityKey extends keyof IPlatformApi
                ? TOwnerKey extends keyof IPlatformApi[TCapabilityKey]
                    ? TMethodKey extends keyof NonNullable<IPlatformApi[TCapabilityKey][TOwnerKey]>
                        ? TCallablePlatformMember<NonNullable<IPlatformApi[TCapabilityKey][TOwnerKey]>[TMethodKey]>
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
