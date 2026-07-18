import type { IAgentCapability } from '@contracts/agentCapability';
import type { IDjvuCapability } from '@contracts/electronApiDjvu';
import type {
    IDocumentsCapability,
    IDocumentsFileIoCapability,
    IImageExportCapability,
    IDocumentsMenuCapability,
    IDocumentsOpenCapability,
    IDocumentsPdfCapability,
    IDocumentsPickerCapability,
    IDocumentsRecentFilesCapability,
    IDocumentsWindowCapability,
    IDocumentsWorkingCopyCapability,
} from '@contracts/electronApiDocuments';
import type { IHostCapability } from '@contracts/electronApiHost';
import type { IOcrCapability } from '@contracts/electronApiOcr';
import type { IPageOpsCapability } from '@contracts/electronApiPageOps';
import type { ISystemCapability } from '@contracts/electronApiSystem';
import type { IUpdatesCapability } from '@contracts/electronApiUpdates';
import type { IWindowTabsCapability } from '@contracts/electronApiWindowTabs';
import type {
    TPlatformBackend,
    IPlatformRuntimeManifest,
} from '@contracts/platformManifest';
import type { ISearchCapability } from '@contracts/searchCapability';
import type { ISettingsCapability } from '@contracts/settingsCapability';
import type { IShellCapability } from '@contracts/shellCapability';
import type {
    Get,
    Join,
    Paths,
} from 'type-fest';

export type TPlatformMethodKind = 'async' | 'event' | 'sync' | 'void';
export type TBrowserPlatformLazyMode = 'forwarded' | 'direct';

interface IPlatformApiShape {
    manifest: IPlatformRuntimeManifest;
    documents: IDocumentsCapability;
    documentPicker?: IDocumentsPickerCapability;
    documentOpen?: IDocumentsOpenCapability;
    documentWorkingCopy?: IDocumentsWorkingCopyCapability;
    documentFiles?: IDocumentsFileIoCapability;
    documentPdf?: IDocumentsPdfCapability;
    documentRecentFiles?: IDocumentsRecentFilesCapability;
    documentWindow?: IDocumentsWindowCapability;
    documentMenu?: IDocumentsMenuCapability;
    pageOps: IPageOpsCapability;
    imageExport: IImageExportCapability;
    ocr: IOcrCapability;
    search: ISearchCapability;
    djvu: IDjvuCapability;
    settings: ISettingsCapability;
    system: ISystemCapability;
    updates: IUpdatesCapability;
    windowTabs: IWindowTabsCapability;
    shell: IShellCapability;
    host: IHostCapability;
    agent: IAgentCapability;
}

type TPlatformApiPath = Extract<Paths<IPlatformApiShape, {maxRecursionDepth: 4}>, string>;
type TPlatformPath = readonly string[];
type TVoidResult = ReturnType<() => void>;
type TPlatformMethodAtPath<TPath extends TPlatformPath> = NonNullable<Get<IPlatformApiShape, Extract<
    Join<TPath, '.'>,
    TPlatformApiPath
>, {strict: false}>>;
type TPlatformMethodKindAtPath<TPath extends TPlatformPath> =
    TPlatformMethodAtPath<TPath> extends (...args: never[]) => infer TResult
        ? TResult extends PromiseLike<unknown>
            ? 'async'
            : TResult extends (...args: never[]) => void
                ? 'event'
                : TResult extends TVoidResult
                    ? 'void'
                    : 'sync'
        : never;

type TConventionMethodKind<TPath extends TPlatformPath> = Join<TPath, '.'> extends
    | 'documentPicker.getPathForFile'
    | 'documentPicker.getPathsForFiles'
    | 'documents.getPathForFile'
    | 'documents.getPathsForFiles'
    | 'system.getMemoryInfo'
    ? 'sync'
    : TPath extends readonly [...string[], infer TMethodName extends string]
        ? TMethodName extends `on${string}`
            ? 'event'
            : TMethodName extends 'notifyRendererReady' | 'rendererLog'
                ? 'void'
                : 'async'
        : never;
type TVerifiedMethodPath<TPath extends TPlatformPath> = Join<TPath, '.'> extends TPlatformApiPath
    ? TPlatformMethodAtPath<TPath> extends (...args: never[]) => unknown
        ? TConventionMethodKind<TPath> extends TPlatformMethodKindAtPath<TPath>
            ? TPlatformMethodKindAtPath<TPath> extends TConventionMethodKind<TPath>
                ? TPath
                : never
            : never
        : never
    : never;

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

type TDocumentSplitRoot = Extract<keyof IPlatformApiShape, `document${string}`>;
interface IDocumentCapabilityMirror {
    splitRoot: TDocumentSplitRoot;
    paths: ReadonlyArray<readonly string[]>;
}

type TVerifiedMethodPaths<TPaths extends readonly TPlatformPath[]> = {
    readonly [TIndex in keyof TPaths]: TPaths[TIndex] extends TPlatformPath
        ? TVerifiedMethodPath<TPaths[TIndex]>
        : never;
};

function defineMethodPaths<const TPaths extends readonly TPlatformPath[]>(
    paths: TPaths & TVerifiedMethodPaths<TPaths>,
): TPaths {
    return paths;
}

type TVerifiedDocumentCapabilityMirror<TMirror extends IDocumentCapabilityMirror> =
    TMirror extends {
        splitRoot: infer TSplitRoot extends TDocumentSplitRoot;
        paths: infer TPaths extends readonly TPlatformPath[];
    }
        ? {
            splitRoot: TSplitRoot;
            paths: TPaths & {
                readonly [TIndex in keyof TPaths]: TPaths[TIndex] extends TPlatformPath
                    ? TVerifiedMethodPath<readonly [TSplitRoot, ...TPaths[TIndex]]> extends never
                        ? never
                        : TVerifiedMethodPath<readonly ['documents', ...TPaths[TIndex]]> extends never
                            ? never
                            : TPaths[TIndex]
                    : never;
            };
        }
        : never;

function defineDocumentCapabilityMirrors<const TMirrors extends readonly IDocumentCapabilityMirror[]>(
    mirrors: TMirrors & {
        readonly [TIndex in keyof TMirrors]: TMirrors[TIndex] extends IDocumentCapabilityMirror
            ? TVerifiedDocumentCapabilityMirror<TMirrors[TIndex]>
            : never;
    },
): TMirrors {
    return mirrors;
}

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

const documentCapabilityMirrors = defineDocumentCapabilityMirrors([
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
            ['getPdfOpeningGeometry'],
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
            ['createManagedTempFileHandle'],
            ['releaseManagedTempFileHandle'],
            ['repairPdf'],
            ['optimizePdfForInteraction'],
            ['optimizePdfAsCopy'],
            ['savePdfNoteTextUpdates'],
            ['savePdfNoteChanges'],
            ['savePdfNativeMutations'],
            ['applyPdfNativeMutationsToWorkingCopy'],
            ['commitStagedPdfNativeMutations'],
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
            ['onMenuToggleContinuousScroll'],
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
] as const);

const optionalDocumentMethodNames = new Set<string>([
    'applyPdfNativeMutationsToWorkingCopy',
    'commitStagedPdfNativeMutations',
    'cancelPdfNativePagePreview',
    'createCombinedPdfFromFiles',
    'createManagedTempFileHandle',
    'getPdfOpeningGeometry',
    'getPdfNativePageSizes',
    'openFolderDialogStructured',
    'optimizePdfAsCopy',
    'optimizePdfForInteraction',
    'renderPdfNativePagePreview',
    'repairPdf',
    'releaseManagedTempFileHandle',
    'resyncWorkingCopy',
    'savePdfNativeMutations',
    'savePdfNoteChanges',
    'savePdfNoteTextUpdates',
    'showItemInFolderStructured',
]);

const optionalHotReloadCompatibleMethodPaths = new Set([
    'ocr.resolveDocumentOcrAvailability',
    'ocr.resolveDocumentOcrPage',
]);

function resolveMethodKind(path: readonly string[]): TPlatformMethodKind {
    const methodName = path.at(-1);
    if (methodName?.startsWith('on')) {
        return 'event';
    }
    if (methodName === 'notifyRendererReady' || methodName === 'rendererLog') {
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

function isOptionalMethodPath(path: readonly string[]) {
    return isOptionalDocumentPath(path) || optionalHotReloadCompatibleMethodPaths.has(path.join('.'));
}

function createMethodDescriptor(
    path: readonly string[],
    overrides: Partial<Omit<IPlatformMethodDescriptor, 'path' | 'kind' | 'browserLazy' | 'aliasOf'>> & { aliasOf?: TPlatformPath } = {},
): IPlatformMethodDescriptor {
    return {
        path,
        kind: resolveMethodKind(path),
        required: isOptionalMethodPath(path) ? optionalEverywhere : requiredEverywhere,
        ...(isOptionalMethodPath(path) ? {optionalWhenImplemented: true} : {}),
        browserLazy: isDirectBrowserMethod(path) ? 'direct' : 'forwarded',
        ...overrides,
    };
}

function defineCapabilities(
    capabilities: readonly IPlatformCapabilityDescriptor[],
): readonly IPlatformCapabilityDescriptor[] {
    return capabilities;
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
            ] as const;
            const splitPath = [
                splitRoot,
                ...path,
            ] as const;
            return [
                createMethodDescriptor(splitPath),
                createMethodDescriptor(legacyPath, {aliasOf: splitPath}),
            ];
        }),
    );
}

const otherMethodPaths = defineMethodPaths([
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
        'getJobState',
    ],
    [
        'ocr',
        'subscribeJob',
    ],
    [
        'ocr',
        'reconnectJob',
    ],
    [
        'ocr',
        'getLanguages',
    ],
    [
        'ocr',
        'resolveDocumentTextCatalog',
    ],
    [
        'ocr',
        'resolveDocumentOcrAvailability',
    ],
    [
        'ocr',
        'resolveDocumentOcrPage',
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
        'startOpenForViewing',
    ],
    [
        'djvu',
        'awaitOpenJob',
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
        'startConvertToPdf',
    ],
    [
        'djvu',
        'awaitConvertJob',
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
        'getJobState',
    ],
    [
        'djvu',
        'subscribeJob',
    ],
    [
        'djvu',
        'cancelPagePreview',
    ],
    [
        'djvu',
        'searchText',
    ],
    [
        'djvu',
        'cancelTextSearch',
    ],
    [
        'djvu',
        'getInfo',
    ],
    [
        'djvu',
        'getPageSourceInfo',
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
        'onTextSearchProgress',
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
        'download',
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
        'saveWorkspaceCheckpoint',
    ],
    [
        'windowTabs',
        'claimWorkspaceCheckpoint',
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
] as const);

export const PLATFORM_API_DESCRIPTOR = {
    capabilities: defineCapabilities([
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
    ]),
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
