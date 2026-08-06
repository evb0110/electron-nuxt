import {
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {encode as encodePng} from 'fast-png';
import type {
    IScanCleanupRasterRenderLimits,
    TScanCleanupLog,
    TScanCleanupRenderPage,
    TScanCleanupRunCommand,
} from '@scan-cleanup-core/types';
import {readPpmDimensions} from '@scan-cleanup-core/rasterLayerDimensions';

const PDFTOPPM_TIMEOUT_MS = 3 * 60 * 1000;

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

function validateCrop(crop: Parameters<TScanCleanupRenderPage>[8]) {
    if (crop === undefined) {
        return;
    }
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

async function renderPage(
    runCommand: TScanCleanupRunCommand,
    format: 'png' | 'ppm',
    paths: Pick<Parameters<TScanCleanupRenderPage>[0], 'pdftoppmBinary'>,
    log: TScanCleanupLog,
    pageNumber: number,
    sourcePdfPath: string,
    outputPath: string,
    dpi: number,
    popplerEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    crop?: Parameters<TScanCleanupRenderPage>[8],
    limits?: Parameters<TScanCleanupRenderPage>[9],
) {
    validateCrop(crop);
    validateRenderLimits(limits);
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
        outputPath.replace(format === 'png' ? /\.png$/u : /\.ppm$/u, ''),
    );
    await runCommand(paths.pdftoppmBinary, commandArgs, {
        commandLabel: `pdftoppm(page=${String(pageNumber)},dpi=${String(dpi)})`,
        timeoutMs: PDFTOPPM_TIMEOUT_MS,
        ...(popplerEnv === undefined ? {} : {env: popplerEnv}),
        ...(signal === undefined ? {} : {signal}),
        log,
    });
}

async function convertPpmToPng(
    ppmPath: string,
    outputPngPath: string,
    limits: IScanCleanupRasterRenderLimits | undefined,
) {
    // Validate the fixed-size header and declared payload on disk before a
    // potentially hostile raster is read into the JS heap.
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
}

export function createScanCleanupRenderers(runCommand: TScanCleanupRunCommand) {
    const renderPageToPng: TScanCleanupRenderPage = async (
        paths,
        log,
        pageNumber,
        sourcePdfPath,
        outputPngPath,
        dpi,
        popplerEnv,
        signal,
        crop,
        limits,
    ) => {
        const ppmPath = `${outputPngPath}.source.ppm`;
        try {
            await renderPage(
                runCommand,
                'ppm',
                paths,
                log,
                pageNumber,
                sourcePdfPath,
                ppmPath,
                dpi,
                popplerEnv,
                signal,
                crop,
                limits,
            );
            await convertPpmToPng(ppmPath, outputPngPath, limits);
        } finally {
            await rm(ppmPath, {force: true});
        }
    };
    const renderPageToPpm: TScanCleanupRenderPage = (
        paths,
        log,
        pageNumber,
        sourcePdfPath,
        outputPpmPath,
        dpi,
        popplerEnv,
        signal,
        crop,
        limits,
    ) => renderPage(
        runCommand,
        'ppm',
        paths,
        log,
        pageNumber,
        sourcePdfPath,
        outputPpmPath,
        dpi,
        popplerEnv,
        signal,
        crop,
        limits,
    );
    return {
        renderPage: renderPageToPng,
        renderPagePpm: renderPageToPpm,
    };
}
