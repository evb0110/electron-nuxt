import {isRecord} from '@contracts/runtimeGuards';
import type { IPlatformApi } from '@contracts/platformApi';
import type { TPlatformBackend } from '@contracts/platformManifest';

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

export type TPlatformMethodPath = {
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

export type TMethodAtPlatformPath<TPath extends TPlatformMethodPath> =
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

export type TPlatformAsyncMethodPath = TPlatformMethodPath;
export type TPlatformEventMethodPath = TPlatformMethodPath;
export type TPlatformVoidMethodPath = TPlatformMethodPath;
export type TPlatformDirectMethodPath = TPlatformMethodPath;
export type TPlatformMethodKind = 'async' | 'event' | 'void' | 'direct';
export type TPlatformMethodBackendSupport = 'required' | 'optional' | 'stub' | 'unsupported';
export type TPlatformMethodStubSemantics =
    | 'browser-document-ref'
    | 'browser-memory-null'
    | 'browser-noop'
    | 'browser-unsupported-result'
    | 'browser-only'
    | 'electron-native';

export interface IPlatformMethodDescriptor {
    kind: TPlatformMethodKind;
    path: TPlatformMethodPath;
    optional: boolean;
    backendSupport: Record<TPlatformBackend, TPlatformMethodBackendSupport>;
    stubSemantics?: TPlatformMethodStubSemantics;
}

interface IPlatformMethodDescriptorOptions {
    optional?: boolean;
    backendSupport?: Partial<Record<TPlatformBackend, TPlatformMethodBackendSupport>>;
    stubSemantics?: TPlatformMethodStubSemantics;
}

type TPlatformPathDescriptor =
    | {
        kind: 'async';
        path: TPlatformAsyncMethodPath;
        optional: boolean;
        backendSupport: Record<TPlatformBackend, TPlatformMethodBackendSupport>;
        stubSemantics?: TPlatformMethodStubSemantics;
    }
    | {
        kind: 'event';
        path: TPlatformEventMethodPath;
        optional: boolean;
        backendSupport: Record<TPlatformBackend, TPlatformMethodBackendSupport>;
        stubSemantics?: TPlatformMethodStubSemantics;
    }
    | {
        kind: 'void';
        path: TPlatformVoidMethodPath;
        optional: boolean;
        backendSupport: Record<TPlatformBackend, TPlatformMethodBackendSupport>;
        stubSemantics?: TPlatformMethodStubSemantics;
    }
    | {
        kind: 'direct';
        path: TPlatformDirectMethodPath;
        optional: boolean;
        backendSupport: Record<TPlatformBackend, TPlatformMethodBackendSupport>;
        stubSemantics?: TPlatformMethodStubSemantics;
    };
type TDescriptorArgs<TPath extends TPlatformMethodPath> =
    readonly [...TPath] | readonly [...TPath, IPlatformMethodDescriptorOptions];

function createBackendSupport(options?: IPlatformMethodDescriptorOptions) {
    return {
        electron: options?.backendSupport?.electron ?? 'required',
        browser: options?.backendSupport?.browser ?? 'required',
    } as const satisfies Record<TPlatformBackend, TPlatformMethodBackendSupport>;
}

function createDescriptor<const TPath extends TPlatformMethodPath>(
    kind: TPlatformMethodKind,
    path: TPath,
    options?: IPlatformMethodDescriptorOptions,
) {
    return {
        kind,
        path,
        optional: options?.optional ?? false,
        backendSupport: createBackendSupport(options),
        ...(options?.stubSemantics === undefined ? {} : {stubSemantics: options.stubSemantics}),
    } as const;
}

function isDescriptorOptions(value: unknown): value is IPlatformMethodDescriptorOptions {
    return isRecord(value)
        && (
            'optional' in value
            || 'backendSupport' in value
            || 'stubSemantics' in value
        );
}

function parseDescriptorArgs<const TPath extends TPlatformMethodPath>(args: TDescriptorArgs<TPath>) {
    const lastArg: unknown = args.at(-1);
    const options = isDescriptorOptions(lastArg) ? lastArg : undefined;
    const pathArgs: readonly unknown[] = options === undefined ? args : args.slice(0, -1);
    const path = pathArgs as TPath;
    return {
        options,
        path,
    };
}

function asyncPath<const TPath extends TPlatformAsyncMethodPath>(...args: TDescriptorArgs<TPath>) {
    const {
        options,
        path,
    } = parseDescriptorArgs(args);
    return createDescriptor('async', path, options);
}

function eventPath<const TPath extends TPlatformEventMethodPath>(...args: TDescriptorArgs<TPath>) {
    const {
        options,
        path,
    } = parseDescriptorArgs(args);
    return createDescriptor('event', path, options);
}

function voidPath<const TPath extends TPlatformVoidMethodPath>(...args: TDescriptorArgs<TPath>) {
    const {
        options,
        path,
    } = parseDescriptorArgs(args);
    return createDescriptor('void', path, options);
}

function directPath<const TPath extends TPlatformDirectMethodPath>(...args: TDescriptorArgs<TPath>) {
    const {
        options,
        path,
    } = parseDescriptorArgs(args);
    return createDescriptor('direct', path, options);
}

function isPlatformPathDescriptor(value: unknown): value is TPlatformPathDescriptor {
    return isRecord(value)
        && (
            value.kind === 'async'
            || value.kind === 'event'
            || value.kind === 'void'
            || value.kind === 'direct'
        )
        && Array.isArray(value.path)
        && isRecord(value.backendSupport);
}

function collectPlatformPathDescriptors(
    value: unknown,
    descriptors: TPlatformPathDescriptor[] = [],
) {
    if (isPlatformPathDescriptor(value)) {
        descriptors.push(value);
        return descriptors;
    }
    if (!isRecord(value)) {
        return descriptors;
    }
    for (const child of Object.values(value)) {
        collectPlatformPathDescriptors(child, descriptors);
    }
    return descriptors;
}

export const platformMethodManifest = {
    documentPicker: {
        openDocumentDialog: asyncPath('documentPicker', 'openDocumentDialog'),
        openPdfDialog: asyncPath('documentPicker', 'openPdfDialog'),
        openCombineDialog: asyncPath('documentPicker', 'openCombineDialog'),
        openFolderDialog: asyncPath('documentPicker', 'openFolderDialog'),
        openFolderDialogStructured: asyncPath('documentPicker', 'openFolderDialogStructured', {
            optional: true,
            backendSupport: {
                electron: 'unsupported',
                browser: 'stub',
            },
            stubSemantics: 'browser-unsupported-result',
        }),
        openImageDialog: asyncPath('documentPicker', 'openImageDialog'),
        getPathForFile: directPath('documentPicker', 'getPathForFile', {stubSemantics: 'browser-document-ref'}),
        getPathsForFiles: directPath('documentPicker', 'getPathsForFiles', {stubSemantics: 'browser-document-ref'}),
        registerFilesForOpen: asyncPath('documentPicker', 'registerFilesForOpen'),
        createCombinedPdfFromFiles: asyncPath('documentPicker', 'createCombinedPdfFromFiles', {
            optional: true,
            backendSupport: {
                electron: 'unsupported',
                browser: 'required',
            },
            stubSemantics: 'browser-only',
        }),
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
        getDocumentRevision: asyncPath('documentFiles', 'getDocumentRevision'),
        onDocumentRevisionChanged: eventPath('documentFiles', 'onDocumentRevisionChanged'),
        getPdfNativePageSizes: asyncPath('documentFiles', 'getPdfNativePageSizes', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
        renderPdfNativePagePreview: asyncPath('documentFiles', 'renderPdfNativePagePreview', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
        savePdfAs: asyncPath('documentFiles', 'savePdfAs'),
        savePdfDataAs: asyncPath('documentFiles', 'savePdfDataAs'),
        savePdfDialog: asyncPath('documentFiles', 'savePdfDialog'),
        saveDocxAs: asyncPath('documentFiles', 'saveDocxAs'),
        writeFile: asyncPath('documentFiles', 'writeFile'),
        replaceWorkingCopyFromPath: asyncPath('documentFiles', 'replaceWorkingCopyFromPath'),
        writeDocxFile: asyncPath('documentFiles', 'writeDocxFile'),
        saveFileStructured: asyncPath('documentFiles', 'saveFileStructured'),
        savePdfData: asyncPath('documentFiles', 'savePdfData'),
        savePdfDataChunks: asyncPath('documentFiles', 'savePdfDataChunks'),
        repairPdf: asyncPath('documentFiles', 'repairPdf', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
        optimizePdfForInteraction: asyncPath('documentFiles', 'optimizePdfForInteraction', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
        optimizePdfAsCopy: asyncPath('documentFiles', 'optimizePdfAsCopy', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
        savePdfNoteTextUpdates: asyncPath('documentFiles', 'savePdfNoteTextUpdates', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
        savePdfNoteChanges: asyncPath('documentFiles', 'savePdfNoteChanges', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
        savePdfNativeMutations: asyncPath('documentFiles', 'savePdfNativeMutations', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
        applyPdfNativeMutationsToWorkingCopy: asyncPath('documentFiles', 'applyPdfNativeMutationsToWorkingCopy', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
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
        showItemInFolderStructured: asyncPath('documentWindow', 'showItemInFolderStructured', {
            optional: true,
            backendSupport: {
                electron: 'unsupported',
                browser: 'stub',
            },
            stubSemantics: 'browser-unsupported-result',
        }),
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
    /**
     * Compatibility-only aggregate for callers that have not migrated to the
     * split document* capability groups above. New call sites should use the
     * narrow documentPicker/documentOpen/documentFiles/documentMenu/etc. groups.
     */
    documents: {
        openDocumentDialog: asyncPath('documents', 'openDocumentDialog'),
        openPdfDialog: asyncPath('documents', 'openPdfDialog'),
        openCombineDialog: asyncPath('documents', 'openCombineDialog'),
        openFolderDialog: asyncPath('documents', 'openFolderDialog'),
        openFolderDialogStructured: asyncPath('documents', 'openFolderDialogStructured', {
            optional: true,
            backendSupport: {
                electron: 'unsupported',
                browser: 'stub',
            },
            stubSemantics: 'browser-unsupported-result',
        }),
        openImageDialog: asyncPath('documents', 'openImageDialog'),
        getPathForFile: directPath('documents', 'getPathForFile', {stubSemantics: 'browser-document-ref'}),
        getPathsForFiles: directPath('documents', 'getPathsForFiles', {stubSemantics: 'browser-document-ref'}),
        registerFilesForOpen: asyncPath('documents', 'registerFilesForOpen'),
        createCombinedPdfFromFiles: asyncPath('documents', 'createCombinedPdfFromFiles', {
            optional: true,
            backendSupport: {
                electron: 'unsupported',
                browser: 'required',
            },
            stubSemantics: 'browser-only',
        }),
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
        getDocumentRevision: asyncPath('documents', 'getDocumentRevision'),
        onDocumentRevisionChanged: eventPath('documents', 'onDocumentRevisionChanged'),
        getPdfNativePageSizes: asyncPath('documents', 'getPdfNativePageSizes', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
        renderPdfNativePagePreview: asyncPath('documents', 'renderPdfNativePagePreview', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
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
        saveFileStructured: asyncPath('documents', 'saveFileStructured'),
        savePdfData: asyncPath('documents', 'savePdfData'),
        savePdfDataChunks: asyncPath('documents', 'savePdfDataChunks'),
        repairPdf: asyncPath('documents', 'repairPdf', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
        optimizePdfForInteraction: asyncPath('documents', 'optimizePdfForInteraction', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
        optimizePdfAsCopy: asyncPath('documents', 'optimizePdfAsCopy', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
        savePdfNoteTextUpdates: asyncPath('documents', 'savePdfNoteTextUpdates', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
        savePdfNoteChanges: asyncPath('documents', 'savePdfNoteChanges', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
        savePdfNativeMutations: asyncPath('documents', 'savePdfNativeMutations', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
        applyPdfNativeMutationsToWorkingCopy: asyncPath('documents', 'applyPdfNativeMutationsToWorkingCopy', {
            optional: true,
            backendSupport: {browser: 'unsupported'},
            stubSemantics: 'electron-native',
        }),
        cleanupFile: asyncPath('documents', 'cleanupFile'),
        cleanupOcrTemp: asyncPath('documents', 'cleanupOcrTemp'),
        setWindowTitle: asyncPath('documents', 'setWindowTitle'),
        showItemInFolder: asyncPath('documents', 'showItemInFolder'),
        showItemInFolderStructured: asyncPath('documents', 'showItemInFolderStructured', {
            optional: true,
            backendSupport: {
                electron: 'unsupported',
                browser: 'stub',
            },
            stubSemantics: 'browser-unsupported-result',
        }),
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
        printDjvuPath: asyncPath('djvu', 'printDjvuPath'),
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
    system: { getMemoryInfo: directPath('system', 'getMemoryInfo', {stubSemantics: 'browser-memory-null'}) },
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

export const platformMethodDescriptorList = collectPlatformPathDescriptors(
    platformMethodManifest,
) satisfies readonly IPlatformMethodDescriptor[];

export const directPlatformMemberPaths = platformMethodDescriptorList
    .filter(descriptor => descriptor.kind === 'direct')
    .map(descriptor => descriptor.path);
