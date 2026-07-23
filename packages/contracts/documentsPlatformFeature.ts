import type {
    IApplicationMenuDocumentState,
    ICreateCombinedPdfFromFilesOptions,
    IPdfOptimizeProgress,
    TOpenDocumentDirectBatchProgress,
    TOpenFileResult,
    TOpenFolderDialogResult,
    TShowItemInFolderResult,
} from '@contracts/electronApiDocuments';
import {
    definePlatformFeature,
    runtimeSchema as s,
    type IRuntimeSchema,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import {
    isFiniteNumber,
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import type { IRecentFile } from '@contracts/shared';

const optionalEverywhere = {
    browser: false,
    electron: false,
} as const;
const requiredEverywhere = {
    browser: true,
    electron: true,
} as const;
const browserImplementedOptional = {
    optionalWhenImplemented: true,
    required: optionalEverywhere,
} as const;
const noArgs = s.tuple([]);
const voidResult = s.undefined();
const stringResult = s.string('/tmp/document.pdf');
const stringArrayResult = s.array(stringResult, ['/tmp/document.pdf']);
const fileArgs = s.trustedDirect<[file: File]>(() => [{} as File]);
const filesArgs = s.trustedDirect<[files: File[]]>(() => [[{} as File]]);
const combinedFilesArgs = s.trustedDirect<[
    files: File[],
    options?: ICreateCombinedPdfFromFilesOptions,
]>(() => [[{} as File]]);
const combinedPdfResult = s.trustedDirect<Uint8Array>(() => new Uint8Array());

function fail(message: string): never {
    throw new Error(message);
}

function defineIpcMethod<
    const TName extends string,
    const TChannel extends string,
    const TArgs extends IRuntimeSchema<unknown[]>,
    const TResult extends IRuntimeSchema<unknown>,
    const TMain extends string,
    const TContext extends 'none' | 'sender',
>(
    name: TName,
    channel: TChannel,
    args: TArgs,
    result: TResult,
    main: TMain,
    context: TContext,
) {
    return {
        kind: 'async',
        channel,
        ipc: {
            args,
            result,
        },
        main: {
            method: main,
            context,
        },
        browser: {method: name},
        lazy: 'forwarded',
    } as const;
}

function defineLocalMethod<
    const TName extends string,
    const TKind extends 'async' | 'void',
    const TArgs extends IRuntimeSchema<unknown[]>,
    const TResult extends IRuntimeSchema<unknown>,
>(name: TName, kind: TKind, args: TArgs, result: TResult) {
    return {
        kind,
        local: {
            args,
            result,
        },
        browser: {method: name},
        lazy: 'forwarded',
    } as const;
}

function defineEvent<
    const TName extends string,
    const TChannel extends string,
    const TPayload extends IRuntimeSchema<unknown>,
>(name: TName, channel: TChannel, payload: TPayload) {
    return {
        kind: 'event',
        channel,
        payload,
        browser: {method: name},
        lazy: 'forwarded',
    } as const;
}

function decodeOpeningGeometry(value: unknown) {
    if (
        !isRecord(value)
        || value.pageNumber !== 1
        || typeof value.pageCount !== 'number'
        || !Number.isSafeInteger(value.pageCount)
        || value.pageCount < 1
        || !isFiniteNumber(value.width)
        || value.width <= 0
        || !isFiniteNumber(value.height)
        || value.height <= 0
        || typeof value.rotation !== 'number'
        || !([
            0,
            90,
            180,
            270,
        ] as const).includes(value.rotation as 0 | 90 | 180 | 270)
        || typeof value.size !== 'number'
        || !Number.isSafeInteger(value.size)
        || value.size < 0
        || typeof value.modifiedAt !== 'number'
        || !Number.isSafeInteger(value.modifiedAt)
        || value.modifiedAt < 0
    ) {
        fail('invalid PDF opening geometry result');
    }
    return {
        pageNumber: 1 as const,
        pageCount: value.pageCount,
        width: value.width,
        height: value.height,
        rotation: value.rotation as 0 | 90 | 180 | 270,
        size: value.size,
        modifiedAt: value.modifiedAt,
    };
}

export function decodeOpenFileResult(value: unknown): TOpenFileResult | null {
    if (value === null) {
        return null;
    }
    if (!isRecord(value) || (value.kind !== 'pdf' && value.kind !== 'djvu')) {
        fail('invalid open-file result');
    }
    if (value.kind === 'djvu') {
        if (value.workingPath !== '' || typeof value.originalPath !== 'string') {
            fail('invalid DjVu open-file result');
        }
        return {
            kind: 'djvu',
            workingPath: '',
            originalPath: value.originalPath,
        };
    }
    if (
        typeof value.workingPath !== 'string'
        || typeof value.originalPath !== 'string'
        || (value.isGenerated !== undefined && typeof value.isGenerated !== 'boolean')
    ) {
        fail('invalid PDF open-file result');
    }
    const openingGeometry = value.openingGeometry === undefined
        ? undefined
        : decodeOpeningGeometry(value.openingGeometry);
    return {
        kind: 'pdf',
        workingPath: value.workingPath,
        originalPath: value.originalPath,
        ...(value.isGenerated === undefined ? {} : {isGenerated: value.isGenerated}),
        ...(openingGeometry === undefined ? {} : {openingGeometry}),
    };
}

function decodeRecentFile(value: unknown): IRecentFile {
    if (
        !isRecord(value)
        || typeof value.originalPath !== 'string'
        || typeof value.fileName !== 'string'
        || !isFiniteNumber(value.timestamp)
        || (value.backend !== undefined && value.backend !== 'electron' && value.backend !== 'browser')
        || (value.fileSize !== undefined && (!isFiniteNumber(value.fileSize) || value.fileSize < 0))
        || (value.modifiedAt !== undefined && (!Number.isSafeInteger(value.modifiedAt) || Number(value.modifiedAt) < 0))
    ) {
        fail('invalid recent file');
    }
    return {
        originalPath: value.originalPath,
        fileName: value.fileName,
        timestamp: value.timestamp,
        ...(value.backend === undefined ? {} : {backend: value.backend}),
        ...(value.fileSize === undefined ? {} : {fileSize: value.fileSize}),
        ...(value.modifiedAt === undefined ? {} : {modifiedAt: Number(value.modifiedAt)}),
    };
}

const applicationMenuOptionalBooleanFields = [
    'interactive',
    'supportsSaveAs',
    'canSaveAs',
    'supportsRepairSave',
    'canRepairSave',
    'supportsOptimizePdf',
    'canOptimizePdf',
    'supportsPrint',
    'canPrint',
    'supportsExportDocx',
    'canExportDocx',
    'supportsRasterExport',
    'canExportRaster',
    'canUndo',
    'canRedo',
    'supportsPdfMutation',
    'canMutatePages',
    'supportsContinuousScroll',
    'canContinuousScroll',
    'continuousScroll',
    'supportsViewMode',
    'isActualSizeActive',
    'isFitWidthActive',
    'isFitHeightActive',
    'canToggleAssistant',
    'canCreatePane',
    'canCloseTab',
    'canTransferActiveTab',
] as const satisfies ReadonlyArray<keyof IApplicationMenuDocumentState>;

function decodeApplicationMenuDocumentState(value: unknown): boolean | IApplicationMenuDocumentState {
    if (typeof value === 'boolean') {
        return value;
    }
    if (!isRecord(value) || typeof value.hasDocument !== 'boolean' || typeof value.canSave !== 'boolean') {
        fail('state must include boolean hasDocument and canSave fields');
    }
    for (const field of applicationMenuOptionalBooleanFields) {
        if (value[field] !== undefined && typeof value[field] !== 'boolean') {
            fail(`state.${field} must be a boolean`);
        }
    }
    for (const field of [
        'selectedPageCount',
        'totalPages',
    ] as const) {
        if (value[field] !== undefined && (
            typeof value[field] !== 'number'
            || !Number.isSafeInteger(value[field])
            || value[field] < 0
        )) {
            fail(`state.${field} must be a non-negative safe integer`);
        }
    }
    if (
        value.viewMode !== undefined
        && !isOneOf([
            'single',
            'facing',
            'facing-first-single',
        ] as const, value.viewMode)
    ) {
        fail('state.viewMode must be a supported PDF view mode');
    }
    return {
        ...value,
        hasDocument: value.hasDocument,
        canSave: value.canSave,
    };
}

function decodeNonNegativeInteger(value: unknown, field: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail(`${field} must be a non-negative safe integer`);
    }
    return value;
}

const openFileResult = s.fromParser<TFileResult>(decodeOpenFileResult, () => null);
type TFileResult = TOpenFileResult | null;
const nullableStringResult = s.fromParser<string | null>(
    value => value === null || typeof value === 'string'
        ? value
        : fail('expected a nullable string'),
    () => null,
);
const recentFilesResult = s.array(
    s.fromParser(decodeRecentFile, () => ({
        originalPath: '/tmp/document.pdf',
        fileName: 'document.pdf',
        timestamp: 0,
    })),
);
const menuStateArgs = s.tuple([s.fromParser(decodeApplicationMenuDocumentState, () => false)]);
const nonNegativeInteger = s.fromParser(
    value => decodeNonNegativeInteger(value, 'value'),
    () => 0,
);
const noPayload = s.undefined();
const optimizeProgress = s.trustedDirect<IPdfOptimizeProgress>(() => ({
    requestId: 'optimize-1',
    preset: 'lossless',
    phase: 'preparing',
    processed: 0,
    total: 1,
    percent: 0,
}));
const openBatchProgress = s.trustedDirect<TOpenDocumentDirectBatchProgress>(() => ({
    operation: 'document-open',
    requestId: 'open-1',
    processed: 0,
    total: 1,
    percent: 0,
    elapsedMs: 0,
    estimatedRemainingMs: null,
}));
const folderDialogResult = s.trustedDirect<TOpenFolderDialogResult>(() => ({
    ok: false,
    reason: 'not-implemented',
}));
const showItemResult = s.trustedDirect<TShowItemInFolderResult>(() => ({
    ok: false,
    reason: 'not-implemented',
}));

const openDocumentDialog = defineIpcMethod(
    'openDocumentDialog',
    'dialog:openPdf',
    noArgs,
    openFileResult,
    'openDocumentDialog',
    'sender',
);
const openDocumentBatchProgressEvent = defineEvent(
    'onOpenDocumentDirectBatchProgress',
    'dialog:openPdfDirectBatch:progress',
    openBatchProgress,
);

export const DOCUMENT_PICKER_PLATFORM_FEATURE = definePlatformFeature({
    path: ['documentPicker'],
    required: requiredEverywhere,
    manifestPath: [
        'documents',
        'picker',
    ],
    methods: {
        openDocumentDialog,
        openPdfDialog: {
            ...openDocumentDialog,
            aliasOf: 'openDocumentDialog',
        },
        openCombineDialog: defineIpcMethod(
            'openCombineDialog', 'dialog:openCombine', noArgs, openFileResult, 'openCombineDialog', 'sender',
        ),
        openFolderDialog: defineIpcMethod(
            'openFolderDialog', 'dialog:openFolder', noArgs, openFileResult, 'openFolderDialog', 'sender',
        ),
        openFolderDialogStructured: {
            ...defineLocalMethod('openFolderDialogStructured', 'async', noArgs, folderDialogResult),
            ...browserImplementedOptional,
        },
        openImageDialog: defineIpcMethod(
            'openImageDialog', 'dialog:openImage', noArgs, nullableStringResult, 'openImageDialog', 'sender',
        ),
        getPathForFile: {
            kind: 'sync',
            args: fileArgs,
            result: stringResult,
            browser: {method: 'getPathForFile'},
            lazy: 'direct',
        },
        getPathsForFiles: {
            kind: 'sync',
            args: filesArgs,
            result: stringArrayResult,
            browser: {method: 'getPathsForFiles'},
            lazy: 'direct',
        },
        registerFilesForOpen: defineLocalMethod(
            'registerFilesForOpen', 'async', filesArgs, stringArrayResult,
        ),
        createCombinedPdfFromFiles: {
            ...defineLocalMethod('createCombinedPdfFromFiles', 'async', combinedFilesArgs, combinedPdfResult),
            ...browserImplementedOptional,
        },
    },
    events: {},
});

export const DOCUMENT_RECENT_FILES_PLATFORM_FEATURE = definePlatformFeature({
    path: [
        'documentRecentFiles',
        'recentFiles',
    ],
    capabilityPath: ['documentRecentFiles'],
    required: requiredEverywhere,
    manifestPath: [
        'documents',
        'recentFiles',
    ],
    methods: {
        get: defineIpcMethod(
            'get', 'recentFiles:get', noArgs, recentFilesResult, 'getRecentFiles', 'sender',
        ),
        remove: defineIpcMethod(
            'remove', 'recentFiles:remove', s.tuple([stringResult]), voidResult, 'removeRecentFile', 'none',
        ),
        clear: defineIpcMethod(
            'clear', 'recentFiles:clear', noArgs, voidResult, 'clearRecentFiles', 'none',
        ),
    },
    events: {},
});

export const DOCUMENT_WINDOW_PLATFORM_FEATURE = definePlatformFeature({
    path: ['documentWindow'],
    required: requiredEverywhere,
    methods: {
        setWindowTitle: defineIpcMethod(
            'setWindowTitle', 'window:setTitle', s.tuple([s.string('Document')]),
            voidResult, 'setWindowTitle', 'sender',
        ),
        showItemInFolder: defineIpcMethod(
            'showItemInFolder', 'shell:showItemInFolder', s.tuple([stringResult]),
            s.boolean(), 'showItemInFolder', 'sender',
        ),
        showItemInFolderStructured: {
            ...defineLocalMethod(
                'showItemInFolderStructured', 'async', s.tuple([stringResult]), showItemResult,
            ),
            ...browserImplementedOptional,
        },
    },
    events: {},
});

export const DOCUMENT_MENU_PLATFORM_FEATURE = definePlatformFeature({
    path: ['documentMenu'],
    required: {
        browser: false,
        electron: true,
    },
    manifestPath: [
        'documents',
        'menuEvents',
    ],
    methods: {
        setMenuDocumentState: defineIpcMethod(
            'setMenuDocumentState', 'menu:setDocumentState', menuStateArgs,
            voidResult, 'setMenuDocumentState', 'sender',
        ),
        setMenuTabCount: defineIpcMethod(
            'setMenuTabCount', 'menu:setTabCount', s.tuple([nonNegativeInteger]),
            voidResult, 'setMenuTabCount', 'sender',
        ),
    },
    events: {
        onPdfOptimizeProgress: defineEvent('onPdfOptimizeProgress', 'pdf:optimize:progress', optimizeProgress),
        onMenuOpenPdf: defineEvent('onMenuOpenPdf', 'menu:openPdf', noPayload),
        onMenuInsertImageFromFile: defineEvent('onMenuInsertImageFromFile', 'menu:insertImageFromFile', noPayload),
        onMenuPasteImageFromClipboard: defineEvent('onMenuPasteImageFromClipboard', 'menu:pasteImageFromClipboard', noPayload),
        onMenuSave: defineEvent('onMenuSave', 'menu:save', noPayload),
        onMenuRepairSave: defineEvent('onMenuRepairSave', 'menu:repairSave', noPayload),
        onMenuOptimizePdfForInteraction: defineEvent('onMenuOptimizePdfForInteraction', 'menu:optimizePdfForInteraction', noPayload),
        onMenuSaveAs: defineEvent('onMenuSaveAs', 'menu:saveAs', noPayload),
        onMenuPrint: defineEvent('onMenuPrint', 'menu:print', noPayload),
        onMenuPrintCurrentPage: defineEvent('onMenuPrintCurrentPage', 'menu:printCurrentPage', noPayload),
        onMenuExportDocx: defineEvent('onMenuExportDocx', 'menu:exportDocx', noPayload),
        onMenuExportImages: defineEvent('onMenuExportImages', 'menu:exportImages', noPayload),
        onMenuExportMultiPageTiff: defineEvent('onMenuExportMultiPageTiff', 'menu:exportMultiPageTiff', noPayload),
        onMenuZoomIn: defineEvent('onMenuZoomIn', 'menu:zoomIn', noPayload),
        onMenuZoomOut: defineEvent('onMenuZoomOut', 'menu:zoomOut', noPayload),
        onMenuActualSize: defineEvent('onMenuActualSize', 'menu:actualSize', noPayload),
        onMenuFitWidth: defineEvent('onMenuFitWidth', 'menu:fitWidth', noPayload),
        onMenuFitHeight: defineEvent('onMenuFitHeight', 'menu:fitHeight', noPayload),
        onMenuToggleContinuousScroll: defineEvent('onMenuToggleContinuousScroll', 'menu:toggleContinuousScroll', noPayload),
        onMenuViewModeSingle: defineEvent('onMenuViewModeSingle', 'menu:viewModeSingle', noPayload),
        onMenuViewModeFacing: defineEvent('onMenuViewModeFacing', 'menu:viewModeFacing', noPayload),
        onMenuViewModeFacingFirstSingle: defineEvent('onMenuViewModeFacingFirstSingle', 'menu:viewModeFacingFirstSingle', noPayload),
        onMenuToggleAssistant: defineEvent('onMenuToggleAssistant', 'menu:toggleAssistant', noPayload),
        onMenuUndo: defineEvent('onMenuUndo', 'menu:undo', noPayload),
        onMenuRedo: defineEvent('onMenuRedo', 'menu:redo', noPayload),
        onMenuDeletePages: defineEvent('onMenuDeletePages', 'menu:deletePages', noPayload),
        onMenuExtractPages: defineEvent('onMenuExtractPages', 'menu:extractPages', noPayload),
        onMenuRotateCw: defineEvent('onMenuRotateCw', 'menu:rotateCw', noPayload),
        onMenuRotateCcw: defineEvent('onMenuRotateCcw', 'menu:rotateCcw', noPayload),
        onMenuInsertPages: defineEvent('onMenuInsertPages', 'menu:insertPages', noPayload),
        onMenuOpenRecentFile: defineEvent('onMenuOpenRecentFile', 'menu:openRecentFile', stringResult),
        onMenuOpenExternalPaths: defineEvent('onMenuOpenExternalPaths', 'menu:openExternalPaths', stringArrayResult),
        onMenuClearRecentFiles: defineEvent('onMenuClearRecentFiles', 'menu:clearRecentFiles', noPayload),
        onOpenDocumentDirectBatchProgress: openDocumentBatchProgressEvent,
        onOpenPdfDirectBatchProgress: {
            ...openDocumentBatchProgressEvent,
            aliasOf: 'onOpenDocumentDirectBatchProgress',
            browser: {method: 'onOpenPdfDirectBatchProgress'},
        },
    },
});

export const DOCUMENTS_SIMPLE_PLATFORM_FEATURES = [
    DOCUMENT_PICKER_PLATFORM_FEATURE,
    DOCUMENT_RECENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_WINDOW_PLATFORM_FEATURE,
    DOCUMENT_MENU_PLATFORM_FEATURE,
] as const;

export type IDocumentPickerPlatformCapability =
    TFeatureCapability<typeof DOCUMENT_PICKER_PLATFORM_FEATURE>;
export type IDocumentRecentFilesPlatformCapability =
    TFeatureCapability<typeof DOCUMENT_RECENT_FILES_PLATFORM_FEATURE>;
export type IDocumentWindowPlatformCapability =
    TFeatureCapability<typeof DOCUMENT_WINDOW_PLATFORM_FEATURE>;
export type IDocumentMenuPlatformCapability =
    TFeatureCapability<typeof DOCUMENT_MENU_PLATFORM_FEATURE>;
export type IDocumentPickerInvokeMap =
    TFeatureInvokeMap<typeof DOCUMENT_PICKER_PLATFORM_FEATURE>;
export type IDocumentRecentFilesInvokeMap =
    TFeatureInvokeMap<typeof DOCUMENT_RECENT_FILES_PLATFORM_FEATURE>;
export type IDocumentWindowInvokeMap =
    TFeatureInvokeMap<typeof DOCUMENT_WINDOW_PLATFORM_FEATURE>;
export type IDocumentMenuInvokeMap =
    TFeatureInvokeMap<typeof DOCUMENT_MENU_PLATFORM_FEATURE>;
export type IDocumentMenuEventMap =
    TFeatureEventMap<typeof DOCUMENT_MENU_PLATFORM_FEATURE>;
