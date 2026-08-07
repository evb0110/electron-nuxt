import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import type {
    IWorkerPaths,
    TWorkerLog,
} from '@electron/ocr/worker/types';
import {
    runOcrCommand,
    type TOcrRunCommandOptions,
} from '@electron/ocr/worker/runOcrCommand';
import {getErrorMessage} from '@electron/utils/error';
import {createScanCleanupRenderers} from '@scan-cleanup-adapters/createScanCleanupRenderers';
export {buildPopplerEnv} from '@electron/native-tools/buildPopplerEnv';

const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
const OCR_MAX_RASTER_PIXELS = 45_000_000;
const OCR_MAX_RASTER_DIMENSION_PX = 40_000;

export interface IPreparedPopplerPdf {
    pdfPath: string;
    warnings: string[];
}

const renderers = createScanCleanupRenderers(runOcrCommand, {
    maxDimensionPx: OCR_MAX_RASTER_DIMENSION_PX,
    maxPixels: OCR_MAX_RASTER_PIXELS,
});
export const renderPdfPageToPng = renderers.renderPage;
export const renderPdfPageToPpm = renderers.renderPagePpm;

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
