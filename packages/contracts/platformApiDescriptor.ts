import type { TPlatformBackend } from '@contracts/platformManifest';

export type TPlatformMethodKind = 'async' | 'event' | 'sync' | 'void';
export type TBrowserPlatformLazyMode = 'forwarded' | 'direct';

export interface IPlatformMethodDescriptor {
    path: readonly string[];
    kind: TPlatformMethodKind;
    required: Record<TPlatformBackend, boolean>;
    optionalWhenImplemented?: boolean;
    aliasOf?: readonly string[];
    browserLazy: TBrowserPlatformLazyMode;
}

export interface IPlatformCapabilityDescriptor {
    path: readonly string[];
    required: Record<TPlatformBackend, boolean>;
    manifestPath?: readonly string[];
}

export interface IPlatformApiDescriptor {
    capabilities: readonly IPlatformCapabilityDescriptor[];
    methods: readonly IPlatformMethodDescriptor[];
}

const requiredEverywhere = {
    browser: true,
    electron: true,
} as const satisfies Record<TPlatformBackend, boolean>;

const optionalEverywhere = {
    browser: false,
    electron: false,
} as const satisfies Record<TPlatformBackend, boolean>;

const requiredInElectron = {
    browser: false,
    electron: true,
} as const satisfies Record<TPlatformBackend, boolean>;

const requiredInBrowser = {
    browser: true,
    electron: false,
} as const satisfies Record<TPlatformBackend, boolean>;

const requiredTopLevelCapabilityPaths = [
    ['pageOps'],
    ['imageExport'],
    ['ocr'],
    ['search'],
    ['djvu'],
    ['settings'],
    ['system'],
    ['shell'],
    ['host'],
] as const;

const documentCapabilityMirrors = [
    {
        splitRoot: 'documentPicker',
        paths: [
            ['openDocumentDialog'],
            ['openPdfDialog'],
            ['openCombineDialog'],
            ['openFolderDialog'],
            ['openFolderDialogStructured'],
            ['openImageDialog'],
            ['getPathForFile'],
            ['getPathsForFiles'],
            ['registerFilesForOpen'],
            ['createCombinedPdfFromFiles'],
        ],
    },
    {
        splitRoot: 'documentOpen',
        paths: [
            ['openDocumentDirect'],
            ['openPdfDirect'],
            ['openDocumentDirectBatch'],
            ['openPdfDirectBatch'],
        ],
    },
    {
        splitRoot: 'documentWorkingCopy',
        paths: [
            ['createWorkingCopyFromData'],
            ['createWorkingCopyFromPath'],
            ['cleanupFile'],
            ['cleanupOcrTemp'],
        ],
    },
    {
        splitRoot: 'documentFiles',
        paths: [
            ['readFile'],
            ['statFile'],
            ['readFileRange'],
            ['getPdfNativePageSizes'],
            ['cancelPdfNativePagePreview'],
            ['renderPdfNativePagePreview'],
            ['readFileChunks'],
            ['readTextFile'],
            ['fileExists'],
            ['getDocumentRevision'],
            ['onDocumentRevisionChanged'],
            ['savePdfAs'],
            ['savePdfDataAs'],
            ['savePdfDialog'],
            ['saveDocxAs'],
            ['writeFile'],
            ['replaceWorkingCopyFromPath'],
            ['writeDocxFile'],
            ['saveFileStructured'],
            ['resyncWorkingCopy'],
            ['savePdfData'],
            ['savePdfDataChunks'],
            ['repairPdf'],
            ['optimizePdfForInteraction'],
            ['optimizePdfAsCopy'],
            ['savePdfNoteTextUpdates'],
            ['savePdfNoteChanges'],
            ['savePdfNativeMutations'],
            ['applyPdfNativeMutationsToWorkingCopy'],
        ],
    },
    {
        splitRoot: 'documentPdf',
        paths: [
            ['analyzePdfConformance'],
            ['validatePdfData'],
            ['validatePdfPath'],
            ['openPdfInDefaultAppData'],
            ['openPdfInDefaultAppPath'],
            ['printPdfData'],
            ['printPdfPath'],
        ],
    },
    {
        splitRoot: 'documentRecentFiles',
        paths: [
            [
                'recentFiles',
                'get',
            ],
            [
                'recentFiles',
                'remove',
            ],
            [
                'recentFiles',
                'clear',
            ],
        ],
    },
    {
        splitRoot: 'documentWindow',
        paths: [
            ['setWindowTitle'],
            ['showItemInFolder'],
            ['showItemInFolderStructured'],
        ],
    },
    {
        splitRoot: 'documentMenu',
        paths: [
            ['setMenuDocumentState'],
            ['setMenuTabCount'],
            ['onPdfOptimizeProgress'],
            ['onMenuOpenPdf'],
            ['onMenuInsertImageFromFile'],
            ['onMenuPasteImageFromClipboard'],
            ['onMenuSave'],
            ['onMenuRepairSave'],
            ['onMenuOptimizePdfForInteraction'],
            ['onMenuSaveAs'],
            ['onMenuPrint'],
            ['onMenuPrintCurrentPage'],
            ['onMenuExportDocx'],
            ['onMenuExportImages'],
            ['onMenuExportMultiPageTiff'],
            ['onMenuZoomIn'],
            ['onMenuZoomOut'],
            ['onMenuActualSize'],
            ['onMenuFitWidth'],
            ['onMenuFitHeight'],
            ['onMenuViewModeSingle'],
            ['onMenuViewModeFacing'],
            ['onMenuViewModeFacingFirstSingle'],
            ['onMenuToggleAssistant'],
            ['onMenuUndo'],
            ['onMenuRedo'],
            ['onMenuDeletePages'],
            ['onMenuExtractPages'],
            ['onMenuRotateCw'],
            ['onMenuRotateCcw'],
            ['onMenuInsertPages'],
            ['onMenuOpenRecentFile'],
            ['onMenuOpenExternalPaths'],
            ['onMenuClearRecentFiles'],
            ['onOpenDocumentDirectBatchProgress'],
            ['onOpenPdfDirectBatchProgress'],
        ],
    },
] as const;

const optionalDocumentMethodNames = new Set<string>([
    'applyPdfNativeMutationsToWorkingCopy',
    'cancelPdfNativePagePreview',
    'createCombinedPdfFromFiles',
    'getPdfNativePageSizes',
    'openFolderDialogStructured',
    'optimizePdfAsCopy',
    'optimizePdfForInteraction',
    'renderPdfNativePagePreview',
    'repairPdf',
    'resyncWorkingCopy',
    'savePdfNativeMutations',
    'savePdfNoteChanges',
    'savePdfNoteTextUpdates',
    'showItemInFolderStructured',
]);

const eventMethodNames = new Set<string>([
    'onAssistantEvent',
    'onCommandCancelRequest',
    'onCommandRequest',
    'onComplete',
    'onDebugLog',
    'onDocumentRevisionChanged',
    'onEnvironmentChange',
    'onIncomingTransfer',
    'onMenuActualSize',
    'onMenuCheckForUpdates',
    'onMenuClearRecentFiles',
    'onMenuCloseTab',
    'onMenuConvertToPdf',
    'onMenuCopyTabToPane',
    'onMenuDeletePages',
    'onMenuExportDocx',
    'onMenuExportImages',
    'onMenuExportMultiPageTiff',
    'onMenuExtractPages',
    'onMenuFitHeight',
    'onMenuFitWidth',
    'onMenuFocusEditorPane',
    'onMenuInsertImageFromFile',
    'onMenuInsertPages',
    'onMenuMoveTabToPane',
    'onMenuNewTab',
    'onMenuOpenExternalPaths',
    'onMenuOpenPdf',
    'onMenuOpenRecentFile',
    'onMenuOpenSettings',
    'onMenuOptimizePdfForInteraction',
    'onMenuPasteImageFromClipboard',
    'onMenuPrint',
    'onMenuPrintCurrentPage',
    'onMenuRedo',
    'onMenuRepairSave',
    'onMenuRotateCcw',
    'onMenuRotateCw',
    'onMenuSave',
    'onMenuSaveAs',
    'onMenuSplitEditor',
    'onMenuToggleAssistant',
    'onMenuUndo',
    'onMenuViewModeFacing',
    'onMenuViewModeFacingFirstSingle',
    'onMenuViewModeSingle',
    'onMenuZoomIn',
    'onMenuZoomOut',
    'onOpenDocumentDirectBatchProgress',
    'onOpenPdfDirectBatchProgress',
    'onPdfOptimizeProgress',
    'onProgress',
    'onStatus',
    'onViewingError',
    'onViewingReady',
    'onWindowAction',
    'onWorkspaceSnapshotRequest',
    'onZenModeChange',
]);

const voidMethodNames = new Set<string>([
    'notifyRendererReady',
    'rendererLog',
]);

function resolveMethodKind(path: readonly string[]): TPlatformMethodKind {
    const methodName = path.at(-1);
    if (methodName !== undefined && eventMethodNames.has(methodName)) {
        return 'event';
    }
    if (methodName !== undefined && voidMethodNames.has(methodName)) {
        return 'void';
    }
    if (path.join('.') === 'system.getMemoryInfo') {
        return 'sync';
    }
    if (
        path.join('.') === 'documentPicker.getPathForFile'
        || path.join('.') === 'documentPicker.getPathsForFiles'
        || path.join('.') === 'documents.getPathForFile'
        || path.join('.') === 'documents.getPathsForFiles'
    ) {
        return 'sync';
    }
    return 'async';
}

function isDirectBrowserMethod(path: readonly string[]) {
    const formattedPath = path.join('.');
    return formattedPath === 'documentPicker.getPathForFile'
        || formattedPath === 'documentPicker.getPathsForFiles'
        || formattedPath === 'documents.getPathForFile'
        || formattedPath === 'documents.getPathsForFiles'
        || formattedPath === 'system.getMemoryInfo';
}

function isOptionalDocumentPath(path: readonly string[]) {
    const methodName = path.at(-1);
    return methodName !== undefined && optionalDocumentMethodNames.has(methodName);
}

function createMethodDescriptor(
    path: readonly string[],
    overrides: Partial<Omit<IPlatformMethodDescriptor, 'path' | 'kind' | 'browserLazy'>> = {},
): IPlatformMethodDescriptor {
    return {
        path,
        kind: resolveMethodKind(path),
        required: isOptionalDocumentPath(path) ? optionalEverywhere : requiredEverywhere,
        ...(isOptionalDocumentPath(path) ? {optionalWhenImplemented: true} : {}),
        browserLazy: isDirectBrowserMethod(path) ? 'direct' : 'forwarded',
        ...overrides,
    };
}

function createDocumentMethodDescriptors() {
    return documentCapabilityMirrors.flatMap(({
        splitRoot,
        paths,
    }) =>
        paths.flatMap((path) => {
            const legacyPath = [
                'documents',
                ...path,
            ];
            const splitPath = [
                splitRoot,
                ...path,
            ];
            return [
                createMethodDescriptor(splitPath),
                createMethodDescriptor(legacyPath, {aliasOf: splitPath}),
            ];
        }),
    );
}

const otherMethodPaths = [
    [
        'pageOps',
        'delete',
    ],
    [
        'pageOps',
        'extract',
    ],
    [
        'pageOps',
        'reorder',
    ],
    [
        'pageOps',
        'insert',
    ],
    [
        'pageOps',
        'insertFile',
    ],
    [
        'pageOps',
        'rotate',
    ],
    [
        'pageOps',
        'crop',
    ],
    [
        'pageOps',
        'removeCrop',
    ],
    [
        'pageOps',
        'getPageGeometry',
    ],
    [
        'imageExport',
        'exportPdfToImages',
    ],
    [
        'imageExport',
        'exportPdfToMultiPageTiff',
    ],
    [
        'imageExport',
        'onProgress',
    ],
    [
        'ocr',
        'recognize',
    ],
    [
        'ocr',
        'recognizeBatch',
    ],
    [
        'ocr',
        'cancel',
    ],
    [
        'ocr',
        'getLanguages',
    ],
    [
        'ocr',
        'validateTools',
    ],
    [
        'ocr',
        'installLanguages',
    ],
    [
        'ocr',
        'acknowledgeResultFile',
    ],
    [
        'ocr',
        'createSearchablePdf',
    ],
    [
        'ocr',
        'onProgress',
    ],
    [
        'ocr',
        'onComplete',
    ],
    [
        'ocr',
        'preprocessing',
        'validate',
    ],
    [
        'ocr',
        'preprocessing',
        'preprocessPage',
    ],
    [
        'search',
        'run',
    ],
    [
        'search',
        'warmIndex',
    ],
    [
        'search',
        'cancel',
    ],
    [
        'search',
        'onProgress',
    ],
    [
        'search',
        'resetCache',
    ],
    [
        'djvu',
        'openForViewing',
    ],
    [
        'djvu',
        'releaseViewingPath',
    ],
    [
        'djvu',
        'convertToPdf',
    ],
    [
        'djvu',
        'printDjvuPath',
    ],
    [
        'djvu',
        'cancel',
    ],
    [
        'djvu',
        'cancelPagePreview',
    ],
    [
        'djvu',
        'getInfo',
    ],
    [
        'djvu',
        'getPageSizes',
    ],
    [
        'djvu',
        'renderPagePreview',
    ],
    [
        'djvu',
        'estimateSizes',
    ],
    [
        'djvu',
        'cleanupTemp',
    ],
    [
        'djvu',
        'onProgress',
    ],
    [
        'djvu',
        'onViewingReady',
    ],
    [
        'djvu',
        'onViewingError',
    ],
    [
        'djvu',
        'onMenuConvertToPdf',
    ],
    [
        'settings',
        'get',
    ],
    [
        'settings',
        'save',
    ],
    [
        'settings',
        'getDebugLogs',
    ],
    [
        'settings',
        'onDebugLog',
    ],
    [
        'settings',
        'rendererLog',
    ],
    [
        'settings',
        'onMenuOpenSettings',
    ],
    [
        'system',
        'getMemoryInfo',
    ],
    [
        'system',
        'onShutdownSaveFlushRequest',
    ],
    [
        'updates',
        'getState',
    ],
    [
        'updates',
        'check',
    ],
    [
        'updates',
        'install',
    ],
    [
        'updates',
        'defer',
    ],
    [
        'updates',
        'skipVersion',
    ],
    [
        'updates',
        'onStatus',
    ],
    [
        'updates',
        'onMenuCheckForUpdates',
    ],
    [
        'windowTabs',
        'transfer',
    ],
    [
        'windowTabs',
        'transferAck',
    ],
    [
        'windowTabs',
        'listTargetWindows',
    ],
    [
        'windowTabs',
        'showContextMenu',
    ],
    [
        'windowTabs',
        'onIncomingTransfer',
    ],
    [
        'windowTabs',
        'onWindowAction',
    ],
    [
        'windowTabs',
        'closeCurrentWindow',
    ],
    [
        'windowTabs',
        'notifyRendererReady',
    ],
    [
        'windowTabs',
        'claimPendingExternalOpenPaths',
    ],
    [
        'windowTabs',
        'acknowledgePendingExternalOpenPaths',
    ],
    [
        'windowTabs',
        'onMenuNewTab',
    ],
    [
        'windowTabs',
        'onMenuCloseTab',
    ],
    [
        'windowTabs',
        'onMenuSplitEditor',
    ],
    [
        'windowTabs',
        'onMenuFocusEditorPane',
    ],
    [
        'windowTabs',
        'onMenuMoveTabToPane',
    ],
    [
        'windowTabs',
        'onMenuCopyTabToPane',
    ],
    [
        'agent',
        'onWorkspaceSnapshotRequest',
    ],
    [
        'agent',
        'submitWorkspaceSnapshot',
    ],
    [
        'agent',
        'onCommandRequest',
    ],
    [
        'agent',
        'onCommandCancelRequest',
    ],
    [
        'agent',
        'submitCommandResponse',
    ],
    [
        'agent',
        'getMcpIntegrationStatus',
    ],
    [
        'agent',
        'setMcpIntegrationEnabled',
    ],
    [
        'agent',
        'getAssistantState',
    ],
    [
        'agent',
        'installAssistantCodex',
    ],
    [
        'agent',
        'startAssistantLogin',
    ],
    [
        'agent',
        'cancelAssistantLogin',
    ],
    [
        'agent',
        'sendAssistantMessage',
    ],
    [
        'agent',
        'interruptAssistant',
    ],
    [
        'agent',
        'resetAssistantChat',
    ],
    [
        'agent',
        'onAssistantEvent',
    ],
    [
        'shell',
        'openExternal',
    ],
    [
        'host',
        'getEnvironment',
    ],
    [
        'host',
        'onEnvironmentChange',
    ],
    [
        'host',
        'getZenModeState',
    ],
    [
        'host',
        'setZenMode',
    ],
    [
        'host',
        'onZenModeChange',
    ],
] as const;

export const PLATFORM_API_DESCRIPTOR = {
    capabilities: [
        {
            path: ['documents'],
            required: requiredEverywhere,
        },
        {
            path: ['documentPicker'],
            required: requiredEverywhere,
            manifestPath: [
                'documents',
                'picker',
            ],
        },
        {
            path: ['documentOpen'],
            required: requiredEverywhere,
        },
        {
            path: ['documentWorkingCopy'],
            required: requiredEverywhere,
        },
        {
            path: ['documentFiles'],
            required: requiredEverywhere,
        },
        {
            path: ['documentPdf'],
            required: requiredEverywhere,
        },
        {
            path: ['documentRecentFiles'],
            required: requiredEverywhere,
            manifestPath: [
                'documents',
                'recentFiles',
            ],
        },
        {
            path: ['documentWindow'],
            required: requiredEverywhere,
        },
        {
            path: ['documentMenu'],
            required: requiredInElectron,
            manifestPath: [
                'documents',
                'menuEvents',
            ],
        },
        ...requiredTopLevelCapabilityPaths.map(path => ({
            path,
            required: requiredEverywhere,
        })),
        {
            path: ['updates'],
            required: requiredInElectron,
            manifestPath: ['updates'],
        },
        {
            path: ['windowTabs'],
            required: requiredEverywhere,
            manifestPath: ['windowTabs'],
        },
        {
            path: ['agent'],
            required: requiredEverywhere,
            manifestPath: ['agent'],
        },
        {
            path: [
                'manifest',
                'capabilities',
                'documents',
                'folderPicker',
            ],
            required: requiredInElectron,
            manifestPath: [
                'documents',
                'folderPicker',
            ],
        },
        {
            path: [
                'manifest',
                'capabilities',
                'documents',
                'nativePaths',
            ],
            required: requiredInElectron,
            manifestPath: [
                'documents',
                'nativePaths',
            ],
        },
        {
            path: [
                'manifest',
                'capabilities',
                'documents',
                'browserDocumentRefs',
            ],
            required: requiredInBrowser,
            manifestPath: [
                'documents',
                'browserDocumentRefs',
            ],
        },
        {
            path: [
                'manifest',
                'capabilities',
                'documents',
                'nativePrint',
            ],
            required: requiredInElectron,
            manifestPath: [
                'documents',
                'nativePrint',
            ],
        },
        {
            path: [
                'manifest',
                'capabilities',
                'documents',
                'nativeOpenInDefaultApp',
            ],
            required: requiredInElectron,
            manifestPath: [
                'documents',
                'nativeOpenInDefaultApp',
            ],
        },
        {
            path: [
                'manifest',
                'capabilities',
                'documents',
                'structuredSaveResult',
            ],
            required: requiredEverywhere,
            manifestPath: [
                'documents',
                'structuredSaveResult',
            ],
        },
    ],
    methods: [
        ...createDocumentMethodDescriptors(),
        ...otherMethodPaths.map(path => createMethodDescriptor(path)),
    ],
} as const satisfies IPlatformApiDescriptor;

export function getPlatformMethodDescriptor(path: readonly string[]) {
    const formattedPath = path.join('.');
    return PLATFORM_API_DESCRIPTOR.methods.find(descriptor => descriptor.path.join('.') === formattedPath);
}

export function getPlatformDocumentCapabilityMirrors() {
    return PLATFORM_API_DESCRIPTOR.methods
        .filter(descriptor => descriptor.aliasOf !== undefined)
        .map(descriptor => ({
            legacyPath: descriptor.path,
            splitPath: descriptor.aliasOf!,
        }));
}
