import { stat } from 'fs/promises';
import { join } from 'path';
import type {
    IWorkerPaths,
    TWorkerLog,
} from '@electron/ocr/worker/types';
import {
    runOcrCommand,
    type TOcrRunCommandOptions,
} from '@electron/ocr/worker/runOcrCommand';
import { getErrorMessage } from '@electron/utils/error';
export { buildPopplerEnv } from '@electron/native-tools/buildPopplerEnv';

const PDFTOPPM_TIMEOUT_MS = 3 * 60 * 1000;
const QPDF_TIMEOUT_MS = 2 * 60 * 1000;

export interface IPreparedPopplerPdf {
    pdfPath: string;
    warnings: string[];
}

export async function renderPdfPageToPng(
    paths: IWorkerPaths,
    log: TWorkerLog,
    pageNumber: number,
    sourcePdfPath: string,
    outputPngPath: string,
    dpi: number,
    popplerEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
) {
    const commandOptions: TOcrRunCommandOptions = {
        commandLabel: `pdftoppm(page=${pageNumber},dpi=${dpi})`,
        timeoutMs: PDFTOPPM_TIMEOUT_MS,
        log,
    };
    if (popplerEnv !== undefined) {
        commandOptions.env = popplerEnv;
    }
    if (signal !== undefined) {
        commandOptions.signal = signal;
    }

    await runOcrCommand(paths.pdftoppmBinary, [
        '-png',
        '-r',
        String(dpi),
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        '-singlefile',
        sourcePdfPath,
        outputPngPath.replace(/\.png$/, ''),
    ], commandOptions);
}

export async function preparePdfForPoppler(
    paths: IWorkerPaths,
    log: TWorkerLog,
    sourcePdfPath: string,
    sessionId: string,
    trackTempFile: (path: string) => string,
    signal?: AbortSignal,
): Promise<IPreparedPopplerPdf> {
    const normalizedPdfPath = trackTempFile(join(paths.tempDir, `${sessionId}-poppler-input.pdf`));

    try {
        const commandOptions: TOcrRunCommandOptions = {
            commandLabel: 'qpdf(poppler-preflight)',
            allowedExitCodes: [
                0,
                3,
            ],
            timeoutMs: QPDF_TIMEOUT_MS,
            log,
        };
        if (signal !== undefined) {
            commandOptions.signal = signal;
        }

        await runOcrCommand(paths.qpdfBinary, [
            sourcePdfPath,
            normalizedPdfPath,
        ], commandOptions);

        const normalizedStat = await stat(normalizedPdfPath);
        if (normalizedStat.size <= 0) {
            throw new Error('qpdf produced an empty normalized PDF');
        }

        log('debug', `Prepared Poppler input via qpdf: ${normalizedPdfPath} (${normalizedStat.size} bytes)`);
        return {
            pdfPath: normalizedPdfPath,
            warnings: [],
        };
    } catch (err) {
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : err;
        }
        const warning = `qpdf preflight failed; falling back to original PDF for Poppler commands: ${getErrorMessage(err)}`;
        log('warn', warning);
        return {
            pdfPath: sourcePdfPath,
            warnings: [warning],
        };
    }
}
