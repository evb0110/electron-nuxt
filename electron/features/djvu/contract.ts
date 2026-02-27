export const DJVU_CHANNELS = {
    openForViewing: 'djvu:openForViewing',
    convertToPdf: 'djvu:convertToPdf',
    cancel: 'djvu:cancel',
    getInfo: 'djvu:getInfo',
    estimateSizes: 'djvu:estimateSizes',
    cleanupTemp: 'djvu:cleanupTemp',
} as const;

export const DJVU_EVENT_CHANNELS = {
    progress: 'djvu:progress',
    viewingReady: 'djvu:viewingReady',
    viewingError: 'djvu:viewingError',
    menuConvertToPdf: 'menu:convertToPdf',
} as const;

interface IDjvuProgress {
    jobId: string;
    phase: 'converting' | 'bookmarks' | 'loading';
    current?: number;
    total?: number;
    percent: number;
}

interface IDjvuInfo {
    pageCount: number;
    sourceDpi: number;
    hasBookmarks: boolean;
    hasText: boolean;
    metadata: Record<string, string>;
}

interface IDjvuSizeEstimate {
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
    pdfPath?: string;
    pageCount?: number;
    jobId?: string;
    error?: string;
}

interface IDjvuConvertResult {
    success: boolean;
    pdfPath?: string;
    jobId?: string;
    error?: string;
}

interface IDjvuViewingReadyEvent {
    pdfPath: string;
    isPartial: boolean;
    jobId?: string;
}

interface IDjvuViewingErrorEvent {
    error: string;
    jobId?: string;
}

interface IDjvuCapability {
    openForViewing: (djvuPath: string) => Promise<IDjvuOpenResult>;
    convertToPdf: (djvuPath: string, outputPath: string, options: IDjvuConvertOptions) => Promise<IDjvuConvertResult>;
    cancel: (jobId: string) => Promise<{ canceled: boolean }>;
    getInfo: (djvuPath: string) => Promise<IDjvuInfo>;
    estimateSizes: (djvuPath: string) => Promise<IDjvuSizeEstimate[]>;
    cleanupTemp: (tempPdfPath: string) => Promise<void>;
    onProgress: (callback: (progress: IDjvuProgress) => void) => () => void;
    onViewingReady: (callback: (data: IDjvuViewingReadyEvent) => void) => () => void;
    onViewingError: (callback: (data: IDjvuViewingErrorEvent) => void) => () => void;
    onMenuConvertToPdf: (callback: () => void) => () => void;
}
