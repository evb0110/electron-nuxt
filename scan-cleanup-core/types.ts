import type {
    IScanCleanupOptions,
    IScanCleanupPagePlanEvidence,
    IScanCleanupSourcePageMetadata,
    TNativeScanCleanupProgressV3,
    TScanCleanupProgress,
    TScanCleanupLayoutByPage,
    TScanCleanupOutputHalf,
    TScanCleanupOutputMode,
    TScanCleanupPageRotation,
} from '@contracts/electronApiScanCleanup';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';

export type TScanCleanupLog = (
    level: 'debug' | 'warn' | 'error',
    message: string,
) => void;

export type TScanCleanupAssemblerBackend =
    | 'native-pdf-image-combine'
    | 'native-pdf-page-ops'
    | 'cli-wasm-pdf-image-combine'
    | 'cli-fallback-img2pdf-qpdf'
    | 'cli-fallback-wasm-or-img2pdf-qpdf'
    | 'cli-fallback-qpdf-page-ops'
    | 'source-preserved';

export type TScanCleanupTransportMode =
    | 'fifo-ppm'
    | 'file-ppm'
    | 'file-png'
    | 'source-preserved';

export interface IPdfPageSize {
    pageNumber: number;
    xPoints: number;
    yPoints: number;
    widthPoints: number;
    heightPoints: number;
    rotation: number;
    dominantImageWidthPx?: number;
    dominantImageHeightPx?: number;
    dominantImageWidthPoints?: number;
    dominantImageHeightPoints?: number;
}

export interface IDetectedPageRaster {
    dpi: number;
    width: number;
    height: number;
    hasBilevelLayer?: boolean;
    backgroundDpi?: number;
}

export interface ISourceDpiDetectionResult {
    documentDpi: number | null;
    pageDpiByNumber: Map<number, number>;
    pageRasterByNumber: Map<number, IDetectedPageRaster>;
}

export function resolveSourceDpi(value: number | null | undefined, fallback = 300) {
    const candidate = value ?? fallback;
    return Number.isFinite(candidate) && candidate > 0
        ? Math.max(1, Math.round(candidate))
        : fallback;
}

export function detectSourceDpiFromPageSizes(
    pageSizes: readonly IPdfPageSize[],
): ISourceDpiDetectionResult | null {
    if (pageSizes.length === 0) {
        return null;
    }
    const pageRasterByNumber = new Map<number, IDetectedPageRaster>();
    for (const page of pageSizes) {
        const {
            dominantImageWidthPx: width,
            dominantImageHeightPx: height,
            dominantImageWidthPoints: widthPoints,
            dominantImageHeightPoints: heightPoints,
        } = page;
        if (
            width === undefined
            || height === undefined
            || widthPoints === undefined
            || heightPoints === undefined
            || !Number.isSafeInteger(width)
            || !Number.isSafeInteger(height)
            || width <= 0
            || height <= 0
            || !Number.isFinite(widthPoints)
            || !Number.isFinite(heightPoints)
            || widthPoints <= 0
            || heightPoints <= 0
        ) {
            return null;
        }
        const dpi = Math.max(
            width / widthPoints * 72,
            height / heightPoints * 72,
        );
        if (!Number.isFinite(dpi) || dpi <= 0) {
            return null;
        }
        pageRasterByNumber.set(page.pageNumber, {
            dpi: Math.max(1, Math.round(dpi)),
            width,
            height,
        });
    }
    const pageDpiByNumber = new Map<number, number>();
    let documentDpi = 0;
    for (const [
        pageNumber,
        raster,
    ] of pageRasterByNumber) {
        pageDpiByNumber.set(pageNumber, raster.dpi);
        documentDpi = Math.max(documentDpi, raster.dpi);
    }
    return {
        documentDpi: documentDpi > 0 ? documentDpi : null,
        pageDpiByNumber,
        pageRasterByNumber,
    };
}

export interface IPdfMrcLayers {
    backgroundDpi: number;
    backgroundPath: string;
    foregroundDpi: number;
    foregroundHeight: number;
    foregroundPath: string;
    foregroundWidth: number;
    selectionMaskDecode: 'default' | 'inverted';
    selectionMaskPath: string;
}

export interface IScanCleanupRunCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    rejectOnStdoutTruncation?: boolean;
    allowedExitCodes?: number[];
    signal?: AbortSignal;
    cancelGroup?: string;
    commandLabel?: string;
    onStdout?: (chunk: string) => void;
    log?: TScanCleanupLog;
}

export interface IScanCleanupProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export type TScanCleanupRunCommand = (
    command: string,
    args: string[],
    options?: IScanCleanupRunCommandOptions,
) => Promise<IScanCleanupProcessResult>;

export type TScanCleanupGetPageCount = (
    pdfPath: string,
    options?: {signal?: AbortSignal},
) => Promise<number>;

export interface IReadPdfPageSizesOptions {
    pdfPageOpsBinary?: string;
    pdfinfoBinary?: string;
    tempDir: string;
    signal?: AbortSignal;
    log: TScanCleanupLog;
    runCommand: TScanCleanupRunCommand;
}

export type TScanCleanupGetPageSizes = (
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
) => Promise<IPdfPageSize[]>;

export type TScanCleanupDetectSourceDpi = (
    pdfPath: string,
    pdfimagesBinary: string | undefined,
    log: TScanCleanupLog,
    commandEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    pageNumbers?: readonly number[],
    onProgress?: (completedPages: number, totalPages: number) => void,
    runCommand?: TScanCleanupRunCommand,
) => Promise<ISourceDpiDetectionResult>;

export interface IScanCleanupRasterRenderLimits {
    expectedWidthPx: number;
    expectedHeightPx: number;
    maxPixels: number;
    maxDimensionPx: number;
    scaleToFitPx?: number;
}

export type TScanCleanupRenderPage = (
    paths: Pick<IScanCleanupWorkerPaths, 'pdftoppmBinary'>,
    log: TScanCleanupLog,
    pageNumber: number,
    sourcePdfPath: string,
    outputPath: string,
    dpi: number,
    popplerEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    crop?: {
        x: number;
        y: number;
        width: number;
        height: number
    },
    limits?: IScanCleanupRasterRenderLimits,
) => Promise<void>;

export type TScanCleanupSidecarProgress = (
    progress: TScanCleanupProgress,
    nativeProgress: TNativeScanCleanupProgressV3,
) => void;

export type TScanCleanupRunSidecar = (
    binaryPath: string,
    manifestPath: string,
    signal: AbortSignal,
    log: TScanCleanupLog,
    onProgress: TScanCleanupSidecarProgress,
    options?: {priority?: 'background'},
) => Promise<void>;

export type TScanCleanupRequirePublishedRaster = (
    path: string | undefined,
    pageNumber: number,
    role: string,
) => Promise<string>;

export type TScanCleanupExtractMrcLayers = (input: {
    pdfPath: string;
    pageNumber: number;
    backgroundOutputPath: string;
    foregroundOutputPath: string;
    selectionMaskOutputPath: string;
    pdfimagesBinary: string | undefined;
    runCommand: TScanCleanupRunCommand;
    log: TScanCleanupLog;
    signal?: AbortSignal;
}) => Promise<IPdfMrcLayers | null>;

export type TScanCleanupExtractMrcLayersBatch = (input: {
    pdfPath: string;
    targets: Array<{
        backgroundOutputPath: string;
        foregroundOutputPath: string;
        pageNumber: number;
        selectionMaskOutputPath: string;
    }>;
    pdfimagesBinary: string | undefined;
    qpdfBinary: string;
    pdfImageCombineBinary: string;
    pdftoppmBinary: string;
    runCommand: TScanCleanupRunCommand;
    log: TScanCleanupLog;
    signal?: AbortSignal;
    onProgress?: (completedPages: number, totalPages: number) => void;
}) => Promise<Map<number, IPdfMrcLayers>>;

export interface IScanCleanupWorkerPaths {
    qpdfBinary: string;
    pdftoppmBinary: string;
    pdfimagesBinary?: string;
    pdfinfoBinary?: string;
    scanCleanupBinary: string;
    pdfImageCombineBinary: string;
    pdfPageOpsBinary?: string;
    /** Whether the selected assembler accepts the Wave 1a JSON envelope. */
    provenanceStampSupport?: boolean;
    assemblyBackend?: TScanCleanupAssemblerBackend;
    transportMode?: TScanCleanupTransportMode;
    tempDir: string;
}

export interface IRunScanCleanupPipelineRequest {
    sourcePdfPath: string;
    outputPdfPath: string;
    options: IScanCleanupOptions;
    sourcePageNumbers?: number[];
    outputModeRecommendations?: Partial<Record<string, TScanCleanupOutputMode>>;
    softAlphaForegroundRecommendations?: Partial<Record<string, boolean>>;
    layoutByPage?: TScanCleanupLayoutByPage;
    sourcePageMetadataByPage?: Partial<Record<string, IScanCleanupSourcePageMetadata>>;
    pagePlanEvidenceByPage?: Partial<Record<string, IScanCleanupPagePlanEvidence>>;
    assemblyBackend?: TScanCleanupAssemblerBackend;
    transportMode?: TScanCleanupTransportMode;
}

export interface IRunScanCleanupPipelineDependencies {
    getPageCount: TScanCleanupGetPageCount;
    getPageSizes?: TScanCleanupGetPageSizes;
    detectSourceDpi: TScanCleanupDetectSourceDpi;
    createRasterPipes?: (
        paths: readonly string[],
        signal: AbortSignal,
        log: TScanCleanupLog,
    ) => Promise<void>;
    renderPage: TScanCleanupRenderPage;
    renderPagePpm: TScanCleanupRenderPage;
    runSidecar: TScanCleanupRunSidecar;
    runCommand: TScanCleanupRunCommand;
    getAvailableScratchBytes: (directory: string) => Promise<number | null>;
    extractMrcLayers?: TScanCleanupExtractMrcLayers;
    extractMrcLayersBatch?: TScanCleanupExtractMrcLayersBatch;
    requirePublishedRaster?: TScanCleanupRequirePublishedRaster;
    hashNativeBinary?: (path: string) => Promise<string>;
}

export interface IScanCleanupCorePolicy {
    totalRamBytes: IScanCleanupRuntimePolicy['totalRamBytes'];
    rasterConcurrency: IScanCleanupRuntimePolicy['rasterConcurrency'];
    logicalCpus: IScanCleanupRuntimePolicy['logicalCpus'];
}

export interface IScanCleanupOutputPageForSummary {
    outputPageNumber: number;
    sourcePageNumber: number;
    semanticMode: TScanCleanupOutputMode;
    representation: string;
    preservationReason: string | null;
    sourceDpi: number | null;
    sourceBackgroundDpi: number | null;
    renderDpi: number;
    illuminationNormalized: boolean;
    textToneApplied: boolean;
    binarizationMode: string | null;
    half: TScanCleanupOutputHalf;
    outputOrdinal: number;
    rotationDegrees: TScanCleanupPageRotation;
    excluded: boolean;
    blank: boolean;
    streamBytes?: {
        composite?: number;
        bilevel?: number;
        background?: number;
        foregroundMask?: number;
        foregroundAlpha?: number;
    };
}

export interface IScanCleanupOutputMapping {
    sourcePage: number;
    half: TScanCleanupOutputHalf;
    outputOrdinal: number | null;
    rotationDegrees: TScanCleanupPageRotation;
    excluded: boolean;
    blank: boolean;
}

export interface IScanCleanupRepresentationReport {
    schemaVersion: 1;
    sourceBytes: number;
    outputBytes: number;
    outputToSourceByteRatio: number;
    compactSourceBudget: unknown;
    outputMappings: IScanCleanupOutputMapping[];
    pages: IScanCleanupOutputPageForSummary[];
}
