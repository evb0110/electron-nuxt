import type {
    IScanCleanupOptions,
    IScanCleanupPagePlanEvidence,
    IScanCleanupSourcePageMetadata,
    TScanCleanupLayoutByPage,
    TScanCleanupOutputMode,
} from '@contracts/electronApiScanCleanup';
import type {getPdfPageCount} from '@electron/pdf/pdfPageCount';
import type {detectSourceDpiDetails} from '@electron/pdf/sourceDpiDetection';
import type {
    renderPdfPageToPng,
    renderPdfPageToPpm,
} from '@electron/ocr/worker/popplerStage';
import type {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import type {runScanCleanupSidecar} from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
import type {readAvailableScratchBytes} from '@electron/features/scan-cleanup/worker/resolveRasterHandoff';
import type {TWorkerLog} from '@electron/ocr/worker/types';
import type {
    extractPdfMrcLayers,
    extractPdfMrcLayersBatch,
} from '@electron/pdf/extractPdfMrcLayers';

export interface IScanCleanupWorkerPaths {
    qpdfBinary: string;
    pdftoppmBinary: string;
    pdfimagesBinary?: string;
    pdfinfoBinary?: string;
    scanCleanupBinary: string;
    pdfImageCombineBinary: string;
    pdfPageOpsBinary?: string;
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
}

export interface IRunScanCleanupPipelineDependencies {
    getPageCount: typeof getPdfPageCount;
    detectSourceDpi: typeof detectSourceDpiDetails;
    createRasterPipes?: (
        paths: readonly string[],
        signal: AbortSignal,
        log: TWorkerLog,
    ) => Promise<void>;
    renderPage: typeof renderPdfPageToPng;
    renderPagePpm: typeof renderPdfPageToPpm;
    runSidecar: typeof runScanCleanupSidecar;
    runCommand: typeof runNativeToolCommand;
    getAvailableScratchBytes: typeof readAvailableScratchBytes;
    extractMrcLayers?: typeof extractPdfMrcLayers;
    extractMrcLayersBatch?: typeof extractPdfMrcLayersBatch;
}
