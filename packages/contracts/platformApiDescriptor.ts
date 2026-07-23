import type { IAgentCapability } from '@contracts/agentCapability';
import type { IDjvuCapability } from '@contracts/electronApiDjvu';
import type {
    IDocumentsCapability,
    IDocumentsFileIoCapability,
    IDocumentsMenuCapability,
    IDocumentsOpenCapability,
    IDocumentsPdfCapability,
    IDocumentsPickerCapability,
    IDocumentsRecentFilesCapability,
    IDocumentsWindowCapability,
    IDocumentsWorkingCopyCapability,
} from '@contracts/electronApiDocuments';
import {
    HOST_PLATFORM_FEATURE,
    type IHostCapability,
} from '@contracts/hostPlatformFeature';
import type { IOcrCapability } from '@contracts/electronApiOcr';
import type { IScanCleanupCapability } from '@contracts/electronApiScanCleanup';
import {
    IMAGE_EXPORT_PLATFORM_FEATURE,
    type IImageExportCapability,
} from '@contracts/imageExportPlatformFeature';
import {
    PAGE_OPS_PLATFORM_FEATURE,
    type IPageOpsCapability,
} from '@contracts/pageOpsPlatformFeature';
import type { ISystemCapability } from '@contracts/electronApiSystem';
import {
    UPDATES_PLATFORM_FEATURE,
    type IUpdatesCapability,
} from '@contracts/updatesPlatformFeature';
import type { IWindowTabsCapability } from '@contracts/electronApiWindowTabs';
import type {
    TPlatformBackend,
    IPlatformRuntimeManifest,
} from '@contracts/platformManifest';
import {
    SEARCH_PLATFORM_FEATURE,
    type ISearchCapability,
} from '@contracts/searchPlatformFeature';
import {
    SETTINGS_PLATFORM_FEATURE,
    type ISettingsCapability,
} from '@contracts/settingsPlatformFeature';
import {
    SHELL_PLATFORM_FEATURE,
    type IShellCapability,
} from '@contracts/shellPlatformFeature';
import type {
    Get,
    Join,
    Paths,
} from 'type-fest';
import type {
    TPlatformMethodKind,
    IPlatformMethodDescriptor,
    IPlatformCapabilityDescriptor,
    IPlatformApiDescriptor,
} from '@contracts/platformDescriptorTypes';

export type {
    TPlatformMethodKind,
    TBrowserPlatformLazyMode,
    IPlatformMethodDescriptor,
    IPlatformCapabilityDescriptor,
    IPlatformApiDescriptor,
} from '@contracts/platformDescriptorTypes';

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
    scanCleanup?: IScanCleanupCapability;
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
    | 'host.getResourceProfile'
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
    ['ocr'],
    ['djvu'],
    ['system'],
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
    if (
        path.join('.') === 'host.getResourceProfile'
        || path.join('.') === 'system.getMemoryInfo'
    ) {
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
        || formattedPath === 'host.getResourceProfile'
        || formattedPath === 'system.getMemoryInfo';
}

function isOptionalDocumentPath(path: readonly string[]) {
    const methodName = path.at(-1);
    return methodName !== undefined && optionalDocumentMethodNames.has(methodName);
}

function isOptionalMethodPath(path: readonly string[]) {
    return isOptionalDocumentPath(path) || optionalHotReloadCompatibleMethodPaths.has(path.join('.'));
}

function isElectronOnlyMethodPath(path: readonly string[]) {
    return path.join('.') === 'updates.onMenuCheckForUpdates';
}

function createMethodDescriptor(
    path: readonly string[],
    overrides: Partial<Omit<IPlatformMethodDescriptor, 'path' | 'kind' | 'browserLazy' | 'aliasOf'>> & { aliasOf?: TPlatformPath } = {},
): IPlatformMethodDescriptor {
    return {
        path,
        kind: resolveMethodKind(path),
        required: isOptionalMethodPath(path)
            ? optionalEverywhere
            : isElectronOnlyMethodPath(path)
                ? requiredInElectron
                : requiredEverywhere,
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
        'scanCleanup',
        'preview',
    ],
    [
        'scanCleanup',
        'cancelPreview',
    ],
    [
        'scanCleanup',
        'detectAll',
    ],
    [
        'scanCleanup',
        'cancelDetection',
    ],
    [
        'scanCleanup',
        'getDetectionJobState',
    ],
    [
        'scanCleanup',
        'subscribeDetectionJob',
    ],
    [
        'scanCleanup',
        'start',
    ],
    [
        'scanCleanup',
        'cancel',
    ],
    [
        'scanCleanup',
        'getJobState',
    ],
    [
        'scanCleanup',
        'subscribeJob',
    ],
    [
        'scanCleanup',
        'reconnectJob',
    ],
    [
        'scanCleanup',
        'pruneGeneratedOutputs',
    ],
    [
        'scanCleanup',
        'onJobState',
    ],
    [
        'scanCleanup',
        'onDetectionJobState',
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
] as const);

export const LEGACY_PLATFORM_API_DESCRIPTOR_WITHOUT_MIGRATED_FEATURES = {
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
            path: ['scanCleanup'],
            required: requiredInElectron,
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

export const PLATFORM_FEATURE_REGISTRY = [
    SEARCH_PLATFORM_FEATURE,
    IMAGE_EXPORT_PLATFORM_FEATURE,
    PAGE_OPS_PLATFORM_FEATURE,
    SETTINGS_PLATFORM_FEATURE,
    SHELL_PLATFORM_FEATURE,
    UPDATES_PLATFORM_FEATURE,
    HOST_PLATFORM_FEATURE,
] as const;

interface IMigratedPlatformFeature {
    platformDescriptors: IPlatformApiDescriptor;
    invokeChannels: Readonly<Record<string, string>>;
    eventChannels: Readonly<Record<string, string>>;
}

function addUniquePlatformValues(
    seen: Set<string>,
    values: Iterable<string>,
    label: string,
) {
    for (const value of values) {
        if (seen.has(value)) {
            throw new Error(`Duplicate ${label}: ${value}`);
        }
        seen.add(value);
    }
}

function mergePlatformDescriptors(
    legacy: IPlatformApiDescriptor,
    features: readonly IMigratedPlatformFeature[],
): IPlatformApiDescriptor {
    const capabilityPaths = new Set(legacy.capabilities.map(descriptor => descriptor.path.join('.')));
    const methodPaths = new Set(legacy.methods.map(descriptor => descriptor.path.join('.')));
    const channels = new Set<string>();
    for (const feature of features) {
        addUniquePlatformValues(capabilityPaths,
            feature.platformDescriptors.capabilities.map(({path}) => path.join('.')),
            'platform capability path');
        addUniquePlatformValues(methodPaths,
            feature.platformDescriptors.methods.map(({path}) => path.join('.')),
            'platform method path');
        addUniquePlatformValues(channels, [
            ...Object.values(feature.invokeChannels),
            ...Object.values(feature.eventChannels),
        ], 'migrated platform channel');
    }
    return {
        capabilities: [
            ...legacy.capabilities,
            ...features.flatMap(feature => feature.platformDescriptors.capabilities),
        ],
        methods: [
            ...legacy.methods,
            ...features.flatMap(feature => feature.platformDescriptors.methods),
        ],
    };
}

export const PLATFORM_API_DESCRIPTOR = mergePlatformDescriptors(
    LEGACY_PLATFORM_API_DESCRIPTOR_WITHOUT_MIGRATED_FEATURES,
    PLATFORM_FEATURE_REGISTRY,
);

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
