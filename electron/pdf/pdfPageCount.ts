import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';

export const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
export const QPDF_OUTPUT_SUCCESS_EXIT_CODES = [
    0,
    3,
];

export interface IPdfPageCountOptions {
    signal?: AbortSignal;
    cancelGroup?: string;
}

export async function getPdfPageCount(pdfPath: string, options: IPdfPageCountOptions = {}) {
    const result = await runNativeToolCommand(getPdfNativeToolPaths().qpdf, [
        '--show-npages',
        pdfPath,
    ], {
        timeoutMs: QPDF_TIMEOUT_MS,
        allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
        commandLabel: 'qpdf(page-count)',
        ...(options.signal ? {signal: options.signal} : {}),
        ...(options.cancelGroup ? {cancelGroup: options.cancelGroup} : {}),
    });
    const pageCount = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error('Failed to read PDF page count');
    }

    return pageCount;
}
