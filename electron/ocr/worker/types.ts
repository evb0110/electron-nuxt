import type { IOcrWord } from '@contracts/shared';

export interface IWorkerPaths {
    tesseractBinary: string;
    tessdataPath: string;
    pdftoppmBinary: string;
    pdftotextBinary: string;
    pdfimagesBinary?: string;
    popplerDataDir?: string;
    popplerFontConfigDir?: string;
    qpdfBinary: string;
    unpaperBinary?: string;
    tempDir: string;
}

export type TOcrWorkerLogLevel = 'debug' | 'warn' | 'error';

export type TWorkerLog = (level: TOcrWorkerLogLevel, message: string) => void;

export interface IOcrPdfPageRequest {
    pageNumber: number;
    languages: string[];
}

export interface IOcrPageWithWords {
    pageNumber: number;
    words: IOcrWord[];
    text: string;
    imageWidth: number;
    imageHeight: number;
}

export interface IOcrFileResult {
    success: boolean;
    pageData: IOcrPageWithWords | null;
    pdfPath: string | null;
    error?: string;
}

export interface IOcrWorkerStartPayload {
    sourcePdfPath: string;
    pages: IOcrPdfPageRequest[];
    renderDpi?: number;
}

export interface IOcrWorkerInboundMessage {
    type: 'start';
    jobId: string;
    data: IOcrWorkerStartPayload;
}

interface IOcrWorkerProgressPayload {
    requestId: string;
    currentPage: number;
    processedCount: number;
    totalPages: number;
}

export type TOcrWorkerCompleteResult =
    | {
        success: true;
        pdfPath: string;
        requiresCleanupAck: boolean;
        errors: string[];
    }
    | {
        success: false;
        errors: string[];
    };

export interface IOcrWorkerProgressMessage {
    type: 'progress';
    jobId: string;
    progress: IOcrWorkerProgressPayload;
}

export interface IOcrWorkerCompleteMessage {
    type: 'complete';
    jobId: string;
    result: TOcrWorkerCompleteResult;
}

export interface IOcrWorkerLogMessage {
    type: 'log';
    level: TOcrWorkerLogLevel;
    message: string;
}

export type TOcrWorkerOutboundMessage =
    | IOcrWorkerProgressMessage
    | IOcrWorkerCompleteMessage
    | IOcrWorkerLogMessage;

export type TRotation = 0 | 90 | 180 | 270;


export interface IOcrIndexV2Manifest {
    version: 2;
    createdAt: number;
    source: { pdfPath: string };
    pageCount: number;
    pageBox: 'crop';
    ocr: {
        engine: 'tesseract';
        languages: string[];
        renderDpi: number;
    };
    pages: Record<number, { path: string }>;
}

export interface IOcrIndexV2Page {
    pageNumber: number;
    rotation: TRotation;
    render: {
        dpi: number;
        imagePx: {
            w: number;
            h: number;
        };
    };
    text: string;
    words: IOcrWord[];
}

export interface IRunCommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
