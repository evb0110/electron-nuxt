import {
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import {encode as encodePng} from 'fast-png';
import type {
    IWorkerPaths,
    TWorkerLog,
} from '@electron/ocr/worker/types';
import {
    runOcrCommand,
    type TOcrRunCommandOptions,
} from '@electron/ocr/worker/runOcrCommand';
import { getErrorMessage } from '@electron/utils/error';
import {readPpmDimensions} from '@scan-cleanup-core/rasterLayerDimensions';
import type {IScanCleanupRasterRenderLimits} from '@scan-cleanup-core/types';
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

function validateRenderLimits(limits: IScanCleanupRasterRenderLimits | undefined) {
    if (limits === undefined) {
        return;
    }
    for (const [
        label,
        value,
    ] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new TypeError(`Poppler raster ${label} must be a positive safe integer`);
        }
    }
    if (
        limits.expectedWidthPx > limits.maxDimensionPx
        || limits.expectedHeightPx > limits.maxDimensionPx
        || limits.expectedWidthPx * limits.expectedHeightPx > limits.maxPixels
    ) {
        throw new RangeError(
            `Poppler raster ${String(limits.expectedWidthPx)}x${String(limits.expectedHeightPx)} exceeds limits`,
        );
    }
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
    limits?: IScanCleanupRasterRenderLimits,
) {
    const ppmPath = `${outputPngPath}.source.ppm`;
    try {
        // Poppler's PNG deflate is slower than the scan-cleanup work on an
        // ordinary page. Its raw PPM renderer produces identical RGB samples
        // several times faster; the bundled PNG codec then compresses those
        // samples without changing them.
        await renderPdfPage('ppm', paths, log, pageNumber, sourcePdfPath, ppmPath, dpi, popplerEnv, signal, crop, limits);
        // Inspect the on-disk header and declared payload before materializing
        // the complete raw raster in the JS heap.
        const inspected = await readPpmDimensions(ppmPath);
        if (
            limits !== undefined
            && (
                inspected.width > limits.maxDimensionPx
                || inspected.height > limits.maxDimensionPx
                || inspected.width * inspected.height > limits.maxPixels
            )
        ) {
            throw new RangeError(
                `Poppler produced raster ${String(inspected.width)}x${String(inspected.height)} beyond limits`,
            );
        }
        const ppm = await readFile(ppmPath);
        const state = {offset: 0};
        const skipWhitespaceAndComments = () => {
            for (;;) {
                while ([
                    0x09,
                    0x0a,
                    0x0d,
                    0x20,
                ].includes(ppm[state.offset]!)) {
                    state.offset += 1;
                }
                if (ppm[state.offset] !== 0x23) {
                    return;
                }
                while (state.offset < ppm.byteLength && ppm[state.offset] !== 0x0a) {
                    state.offset += 1;
                }
            }
        };
        const token = (label: string) => {
            skipWhitespaceAndComments();
            const start = state.offset;
            while (
                state.offset < ppm.byteLength
                && ![
                    0x09,
                    0x0a,
                    0x0d,
                    0x20,
                ].includes(ppm[state.offset]!)
            ) {
                state.offset += 1;
            }
            if (start === state.offset) throw new Error(`Invalid Poppler PPM ${label}`);
            return ppm.subarray(start, state.offset).toString('ascii');
        };
        if (token('magic') !== 'P6') throw new Error('Poppler produced an unsupported PPM raster');
        const width = Number.parseInt(token('width'), 10);
        const height = Number.parseInt(token('height'), 10);
        const maxValue = Number.parseInt(token('max value'), 10);
        if (
            !Number.isSafeInteger(width)
            || width < 1
            || !Number.isSafeInteger(height)
            || height < 1
            || maxValue !== 255
        ) {
            throw new Error('Poppler produced an invalid PPM raster');
        }
        const terminator = ppm[state.offset];
        if (![
            0x09,
            0x0a,
            0x0d,
            0x20,
        ].includes(terminator!)) {
            throw new Error('Poppler produced an invalid PPM header');
        }
        state.offset += terminator === 0x0d && ppm[state.offset + 1] === 0x0a ? 2 : 1;
        const byteLength = width * height * 3;
        const pixels = ppm.subarray(state.offset, state.offset + byteLength);
        if (!Number.isSafeInteger(byteLength) || pixels.byteLength !== byteLength) {
            throw new Error('Poppler produced a truncated PPM raster');
        }
        if (width !== inspected.width || height !== inspected.height) {
            throw new Error('Poppler PPM header changed while it was being read');
        }
        await writeFile(outputPngPath, encodePng({
            channels: 3,
            data: pixels,
            depth: 8,
            height,
            width,
        }));
    } finally {
        await rm(ppmPath, {force: true});
    }
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
    crop?: IPopplerPixelCrop,
    limits?: IScanCleanupRasterRenderLimits,
) {
    await renderPdfPage('ppm', paths, log, pageNumber, sourcePdfPath, outputPpmPath, dpi, popplerEnv, signal, crop, limits);
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
    limits?: IScanCleanupRasterRenderLimits,
) {
    validateRenderLimits(limits);
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
        ...(limits?.scaleToFitPx === undefined ? [] : [
            '-scale-to',
            String(limits.scaleToFitPx),
        ]),
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
