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

export interface IPopplerPixelCrop {
    x: number;
    y: number;
    width: number;
    height: number;
}

export async function renderPdfPageToPng(
    paths: Pick<IWorkerPaths, 'pdftoppmBinary'>,
    log: TWorkerLog,
    pageNumber: number,
    sourcePdfPath: string,
    outputPngPath: string,
    dpi: number,
    popplerEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    crop?: IPopplerPixelCrop,
) {
    await renderPdfPage('png', paths, log, pageNumber, sourcePdfPath, outputPngPath, dpi, popplerEnv, signal, crop);
}

// Raw PPM P6 skips PNG deflate on both sides of the native handoff: pdftoppm
// writes it an order of magnitude faster than PNG at scan DPI and the cleanup
// engine reads it without inflating.
export async function renderPdfPageToPpm(
    paths: Pick<IWorkerPaths, 'pdftoppmBinary'>,
    log: TWorkerLog,
    pageNumber: number,
    sourcePdfPath: string,
    outputPpmPath: string,
    dpi: number,
    popplerEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
) {
    await renderPdfPage('ppm', paths, log, pageNumber, sourcePdfPath, outputPpmPath, dpi, popplerEnv, signal);
}

async function renderPdfPage(
    format: 'png' | 'ppm',
    paths: Pick<IWorkerPaths, 'pdftoppmBinary'>,
    log: TWorkerLog,
    pageNumber: number,
    sourcePdfPath: string,
    outputPath: string,
    dpi: number,
    popplerEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    crop?: IPopplerPixelCrop,
) {
    if (crop !== undefined) {
        for (const field of [
            'x',
            'y',
            'width',
            'height',
        ] as const) {
            const value = crop[field];
            const minimum = field === 'x' || field === 'y' ? 0 : 1;
            if (!Number.isSafeInteger(value) || value < minimum) {
                throw new TypeError(
                    `Poppler pixel crop ${field} must be a ${minimum === 0 ? 'non-negative' : 'positive'} safe integer`,
                );
            }
        }
    }

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

    const commandArgs = [
        ...(format === 'png' ? ['-png'] : []),
        '-cropbox',
        '-r',
        String(dpi),
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        '-singlefile',
    ];
    if (crop !== undefined) {
        commandArgs.push(
            '-x',
            String(crop.x),
            '-y',
            String(crop.y),
            '-W',
            String(crop.width),
            '-H',
            String(crop.height),
        );
    }
    commandArgs.push(
        sourcePdfPath,
        outputPath.replace(format === 'png' ? /\.png$/ : /\.ppm$/, ''),
    );

    await runOcrCommand(paths.pdftoppmBinary, commandArgs, commandOptions);
}

export async function preparePdfForPoppler(
    paths: Pick<IWorkerPaths, 'qpdfBinary' | 'tempDir'>,
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
