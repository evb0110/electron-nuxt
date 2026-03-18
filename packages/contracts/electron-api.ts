import type { TGroupDirection } from './editor-groups';
import type { TDocumentRef } from './document';
import type {
    IPdfSearchProgress,
    IPdfSearchRequestOptions,
    IPdfSearchResponse,
} from './search';
import type {
    ICropMargins,
    IOcrLanguage,
    IPageGeometry,
    IRecentFile,
    ISettingsData,
} from './shared';
import type {
    IWindowTabIncomingTransfer,
    IWindowTabTargetWindow,
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    IWindowTabTransferResult,
    TWindowTabsAction,
} from './window-tabs';

export interface IMenuEventCallback {(): void;}

export interface IMenuEventUnsubscribe {(): void;}

interface IOcrRecognizeRequest {
    pageNumber: number;
    imageData: Uint8Array;
    languages: string[];
}

interface IOcrRecognizeResult {
    pageNumber: number;
    success: boolean;
    text: string;
    error?: string;
}

interface IOcrProgress {
    requestId: string;
    currentPage: number;
    processedCount: number;
    totalPages: number;
}

interface IOcrJobStartResult {
    started: boolean;
    jobId: string;
    error?: string;
}

interface IOcrResultFileAckResult {
    cleaned: boolean;
    error?: string;
}

interface IOcrCompleteResult {
    requestId: string;
    success: boolean;
    pdfPath?: TDocumentRef;
    requiresCleanupAck?: boolean;
    errors: string[];
}

export interface IDebugLogEntry {
    source: string;
    message: string;
    timestamp: string;
}

export interface IRendererLogEntry {
    level: 'debug' | 'info' | 'warn' | 'error';
    section: string;
    message: string;
    timestamp: string;
    data?: unknown;
}

interface IOpenPdfDirectBatchProgress {
    requestId: string;
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface IPreprocessingValidationResult {
    valid: boolean;
    available: string[];
    missing: string[];
}

interface IPreprocessPageResult {
    success: boolean;
    imageData: Uint8Array;
    message?: string;
    error?: string;
}

type TPageOpsRotationAngle = 90 | 180 | 270;

interface IPageOpsResult {
    success: boolean;
    pageCount?: number;
}

interface IPageOpsExtractResult {
    success: boolean;
    canceled?: boolean;
    destPath?: TDocumentRef;
}

interface IPageOpsInsertResult {
    success: boolean;
    canceled?: boolean;
}

interface IPageOpsAPI {
    delete: (workingCopyPath: TDocumentRef, pages: number[], totalPages: number) => Promise<IPageOpsResult>;
    extract: (workingCopyPath: TDocumentRef, pages: number[]) => Promise<IPageOpsExtractResult>;
    reorder: (workingCopyPath: TDocumentRef, newOrder: number[]) => Promise<IPageOpsResult>;
    insert: (workingCopyPath: TDocumentRef, totalPages: number, afterPage: number) => Promise<IPageOpsInsertResult>;
    insertFile: (workingCopyPath: TDocumentRef, totalPages: number, afterPage: number, sourcePaths: TDocumentRef[]) => Promise<IPageOpsResult>;
    rotate: (workingCopyPath: TDocumentRef, pages: number[], angle: TPageOpsRotationAngle) => Promise<IPageOpsResult>;
    crop: (workingCopyPath: TDocumentRef, pages: number[], margins: ICropMargins) => Promise<IPageOpsResult>;
    removeCrop: (workingCopyPath: TDocumentRef, pages: number[]) => Promise<IPageOpsResult>;
    getPageGeometry: (workingCopyPath: TDocumentRef, pageNumber: number) => Promise<IPageGeometry>;
}

export interface IDjvuProgress {
    jobId: string;
    phase: 'converting' | 'bookmarks' | 'loading';
    current?: number;
    total?: number;
    percent: number;
}

export interface IDjvuInfo {
    pageCount: number;
    sourceDpi: number;
    hasBookmarks: boolean;
    hasText: boolean;
    metadata: Record<string, string>;
}

export interface IDjvuSizeEstimate {
    subsample: number;
    label: string;
    description: string;
    resultingDpi: number;
    estimatedBytes: number;
}

interface IDjvuConvertOptions {
    subsample?: number;
    preserveBookmarks?: boolean;
}

interface IDjvuOpenResult {
    success: boolean;
    pdfPath?: TDocumentRef;
    pageCount?: number;
    jobId?: string;
    error?: string;
}

interface IDjvuConvertResult {
    success: boolean;
    pdfPath?: TDocumentRef;
    jobId?: string;
    error?: string;
}

export interface IDjvuViewingReadyEvent {
    pdfPath: TDocumentRef;
    isPartial: boolean;
    jobId?: string;
}

export interface IDjvuViewingErrorEvent {
    error: string;
    jobId?: string;
}

export type TAppUpdateCheckOrigin = 'auto' | 'manual';
export type TAppUpdatePhase = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'no-update' | 'error' | 'unsupported';

export interface IAppUpdateStatus {
    phase: TAppUpdatePhase;
    origin: TAppUpdateCheckOrigin;
    version: string | null;
    percent: number | null;
    message: string | null;
}

interface IWindowTabsApi {
    transfer: (request: IWindowTabTransferRequest) => Promise<IWindowTabTransferResult>;
    transferAck: (ack: IWindowTabTransferAck) => Promise<boolean>;
    listTargetWindows: () => Promise<IWindowTabTargetWindow[]>;
    showContextMenu: (tabId: string) => Promise<void>;
    onIncomingTransfer: (callback: (transfer: IWindowTabIncomingTransfer) => void) => IMenuEventUnsubscribe;
    onWindowAction: (callback: (action: TWindowTabsAction) => void) => IMenuEventUnsubscribe;
}

interface IDjvuAPI {
    openForViewing: (djvuPath: TDocumentRef) => Promise<IDjvuOpenResult>;
    convertToPdf: (djvuPath: TDocumentRef, outputPath: string, options: IDjvuConvertOptions) => Promise<IDjvuConvertResult>;
    cancel: (jobId: string) => Promise<{ canceled: boolean }>;
    getInfo: (djvuPath: TDocumentRef) => Promise<IDjvuInfo>;
    estimateSizes: (djvuPath: TDocumentRef) => Promise<IDjvuSizeEstimate[]>;
    cleanupTemp: (tempPdfPath: TDocumentRef) => Promise<void>;
    onProgress: (callback: (progress: IDjvuProgress) => void) => () => void;
    onViewingReady: (callback: (data: IDjvuViewingReadyEvent) => void) => () => void;
    onViewingError: (callback: (data: IDjvuViewingErrorEvent) => void) => () => void;
}

interface IOpenPdfResult {
    kind: 'pdf';
    workingPath: TDocumentRef;
    originalPath: TDocumentRef;
    isGenerated?: boolean;
}

interface IOpenDjvuResult {
    kind: 'djvu';
    workingPath: '';
    originalPath: TDocumentRef;
}

export type TOpenFileResult = IOpenPdfResult | IOpenDjvuResult;
export type TPdfSaveMode = 'incremental' | 'rewrite' | 'save_as_rewrite';

export interface IPdfConformanceProfile {
    isSigned: boolean;
    isEncrypted: boolean;
    isTagged: boolean;
    pdfaLevel: string | null;
    hasAcroForm: boolean;
    hasXfa: boolean;
    canIncrementalSave: boolean;
    saveRestrictions: string[];
}

export interface IPdfValidationResult {
    isValid: boolean;
    tool: 'qpdf' | 'browser';
    errors: string[];
    warnings: string[];
}

export interface IImageExportCapability {
    exportPdfToImages: (workingCopyPath: TDocumentRef, pageNumbers?: number[]) => Promise<{
        success: boolean;
        canceled?: boolean;
        outputPaths?: TDocumentRef[];
    }>;
    exportPdfToMultiPageTiff: (workingCopyPath: TDocumentRef, pageNumbers?: number[]) => Promise<{
        success: boolean;
        canceled?: boolean;
        outputPath?: TDocumentRef;
    }>;
}

export interface IPageOpsCapability {pageOps: IPageOpsAPI;}

export interface IDocumentsMenuCapability {
    setMenuDocumentState: (hasDocument: boolean) => Promise<void>;
    setMenuTabCount: (tabCount: number) => Promise<void>;
    onMenuOpenPdf: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuInsertImageFromFile: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuPasteImageFromClipboard: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSave: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSaveAs: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuExportDocx: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuExportImages: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuExportMultiPageTiff: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuZoomIn: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuZoomOut: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuActualSize: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuFitWidth: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuFitHeight: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuViewModeSingle: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuViewModeFacing: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuViewModeFacingFirstSingle: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuUndo: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuRedo: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuDeletePages: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuExtractPages: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuRotateCw: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuRotateCcw: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuInsertPages: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuOpenRecentFile: (callback: (path: TDocumentRef) => void) => IMenuEventUnsubscribe;
    onMenuOpenExternalPaths: (callback: (paths: TDocumentRef[]) => void) => IMenuEventUnsubscribe;
    onMenuClearRecentFiles: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onOpenPdfDirectBatchProgress: (callback: (progress: IOpenPdfDirectBatchProgress) => void) => IMenuEventUnsubscribe;
}

export interface IDocumentsFileCapability {
    openPdfDialog: () => Promise<TOpenFileResult | null>;
    openImageDialog: () => Promise<string | null>;
    openPdfDirect: (path: TDocumentRef) => Promise<TOpenFileResult | null>;
    openPdfDirectBatch: (paths: TDocumentRef[], requestId?: string) => Promise<TOpenFileResult | null>;
    savePdfAs: (workingCopyPath: TDocumentRef) => Promise<TDocumentRef | null>;
    savePdfDialog: (suggestedName: string) => Promise<string | null>;
    saveDocxAs: (workingCopyPath: TDocumentRef) => Promise<TDocumentRef | null>;
    readFile: (path: TDocumentRef) => Promise<Uint8Array>;
    statFile: (path: TDocumentRef) => Promise<{ size: number }>;
    readFileRange: (path: TDocumentRef, offset: number, length: number) => Promise<Uint8Array>;
    readTextFile: (path: TDocumentRef) => Promise<string>;
    fileExists: (path: TDocumentRef) => Promise<boolean>;
    analyzePdfConformance: (path: TDocumentRef) => Promise<IPdfConformanceProfile>;
    validatePdfData: (data: Uint8Array, fileName?: string) => Promise<IPdfValidationResult>;
    writeFile: (path: TDocumentRef, data: Uint8Array) => Promise<boolean>;
    writeDocxFile: (path: TDocumentRef, data: Uint8Array) => Promise<boolean>;
    createWorkingCopyFromData: (fileName: string, data: Uint8Array, originalPath?: TDocumentRef) => Promise<TDocumentRef>;
    createWorkingCopyFromPath: (sourcePath: TDocumentRef, originalPath?: TDocumentRef) => Promise<TDocumentRef>;
    saveFile: (path: TDocumentRef) => Promise<boolean>;
    cleanupFile: (path: TDocumentRef) => Promise<void>;
    cleanupOcrTemp: (path: TDocumentRef) => Promise<void>;
    setWindowTitle: (title: string) => Promise<void>;
    showItemInFolder: (path: TDocumentRef) => Promise<boolean>;

    recentFiles: {
        get: () => Promise<IRecentFile[]>;
        add: (path: TDocumentRef) => Promise<void>;
        remove: (path: TDocumentRef) => Promise<void>;
        clear: () => Promise<void>;
    };

    getPathForFile: (file: File) => TDocumentRef;
}

export interface IDocumentsCapability extends
    IDocumentsFileCapability,
    IDocumentsMenuCapability,
    IImageExportCapability,
    IPageOpsCapability {}

export interface IOcrCapability {
    recognize: (request: IOcrRecognizeRequest) => Promise<IOcrRecognizeResult>;
    recognizeBatch: (
        pages: IOcrRecognizeRequest[],
        requestId: string,
    ) => Promise<{
        results: Record<number, string>;
        errors: string[];
    }>;
    cancel: (requestId: string) => Promise<{ canceled: boolean }>;
    getLanguages: () => Promise<IOcrLanguage[]>;
    acknowledgeResultFile: (requestId: string, pdfPath?: TDocumentRef) => Promise<IOcrResultFileAckResult>;
    createSearchablePdf: (
        sourcePdfPath: string,
        pages: Array<{
            pageNumber: number;
            languages: string[];
        }>,
        requestId: string,
        renderDpi?: number,
    ) => Promise<IOcrJobStartResult>;
    onProgress: (callback: (progress: IOcrProgress) => void) => () => void;
    onComplete: (callback: (result: IOcrCompleteResult) => void) => () => void;

    preprocessing: {
        validate: () => Promise<IPreprocessingValidationResult>;
        preprocessPage: (imageData: Uint8Array, usePreprocessing: boolean) => Promise<IPreprocessPageResult>;
    };
}

export interface ISearchCapability {
    run: (
        pdfPath: string,
        query: string,
        options?: IPdfSearchRequestOptions,
    ) => Promise<IPdfSearchResponse>;
    warmIndex: (
        pdfPath: string,
        options?: IPdfSearchRequestOptions,
    ) => Promise<boolean>;
    cancel: (requestId?: string) => Promise<{ canceled: boolean }>;
    onProgress: (callback: (progress: IPdfSearchProgress) => void) => () => void;
    resetCache: () => Promise<boolean>;
}

export interface ISettingsCapability {
    get: () => Promise<ISettingsData>;
    save: (settings: ISettingsData) => Promise<void>;
    getDebugLogs: () => Promise<IDebugLogEntry[]>;
    rendererLog: (entry: IRendererLogEntry) => void;
    onMenuOpenSettings: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
}

export interface IUpdatesCapability {
    getState: () => Promise<IAppUpdateStatus>;
    check: () => Promise<{ started: boolean }>;
    install: () => Promise<{ started: boolean }>;
    defer: () => Promise<void>;
    skipVersion: (version: string) => Promise<void>;
    onStatus: (callback: (status: IAppUpdateStatus) => void) => IMenuEventUnsubscribe;
    onMenuCheckForUpdates: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
}

export interface IWindowTabsCapability extends IWindowTabsApi {
    closeCurrentWindow: () => Promise<boolean>;
    notifyRendererReady: () => void;
    onMenuNewTab: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuCloseTab: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSplitEditor: (callback: (direction: TGroupDirection) => void) => IMenuEventUnsubscribe;
    onMenuFocusEditorGroup: (callback: (direction: TGroupDirection) => void) => IMenuEventUnsubscribe;
    onMenuMoveTabToGroup: (callback: (direction: TGroupDirection) => void) => IMenuEventUnsubscribe;
    onMenuCopyTabToGroup: (callback: (direction: TGroupDirection) => void) => IMenuEventUnsubscribe;
}

export interface IDjvuCapability extends IDjvuAPI {onMenuConvertToPdf: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;}

export interface IShellCapability {openExternal: (url: string) => Promise<void>;}

export interface IElectronAPI {
    documents: IDocumentsCapability;
    ocr: IOcrCapability;
    search: ISearchCapability;
    djvu: IDjvuCapability;
    settings: ISettingsCapability;
    updates: IUpdatesCapability;
    windowTabs: IWindowTabsCapability;
    shell: IShellCapability;
}
