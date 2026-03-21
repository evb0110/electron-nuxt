import type { IPdfBookmarkEntry } from '@contracts/pdf';

export interface IDjvuPdfBuildTask {
    type: 'buildPdf';
    imagePaths: string[];
    dpi: number;
}

export interface IDjvuPdfEstimateTask {
    type: 'estimatePdfSize';
    imagePath: string;
    dpi: number;
}

export interface IDjvuPdfBookmarkTask {
    type: 'embedBookmarks';
    pdfData: Uint8Array | ArrayBuffer;
    bookmarks: IPdfBookmarkEntry[];
}

export type TDjvuPdfWorkerTask =
    | IDjvuPdfBuildTask
    | IDjvuPdfEstimateTask
    | IDjvuPdfBookmarkTask;

export interface IDjvuPdfWorkerProgressMessage {
    type: 'progress';
    phase: 'buildPdf';
    page: number;
    total: number;
}

export interface IDjvuPdfWorkerSuccessMessage {
    type: 'result';
    ok: true;
    data: Uint8Array | ArrayBuffer | number;
}

export interface IDjvuPdfWorkerErrorMessage {
    type: 'result';
    ok: false;
    error: string;
}

export type TDjvuPdfWorkerMessage =
    | IDjvuPdfWorkerProgressMessage
    | IDjvuPdfWorkerSuccessMessage
    | IDjvuPdfWorkerErrorMessage;
