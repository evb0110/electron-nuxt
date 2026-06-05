import { app } from 'electron';
import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import { getOcrToolPaths } from '@electron/ocr/paths';
import { createLogger } from '@electron/utils/logger';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { resolveUnpackedWorkerPath } from '@electron/utils/workerTask';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = createLogger('ocr-ipc');

function getOcrWorkerPath() {
    const defaultPath = join(__dirname, WORKER_BUNDLES_BY_ID.ocr.fileName);
    if (!app?.isPackaged && existsSync(defaultPath)) {
        return defaultPath;
    }

    const resolvedPath = resolveUnpackedWorkerPath(__dirname, WORKER_BUNDLES_BY_ID.ocr.fileName);
    if (existsSync(resolvedPath)) {
        return resolvedPath;
    }

    if (existsSync(defaultPath)) {
        return defaultPath;
    }

    const unpackedPath = defaultPath.replace('app.asar', 'app.asar.unpacked');
    throw new Error(`OCR worker script not found. lookedFor="${unpackedPath}", fallback="${defaultPath}"`);
}

export function createOcrWorker(): Worker {
    const paths = getOcrToolPaths();
    const workerPath = getOcrWorkerPath();

    if (!existsSync(workerPath)) {
        throw new Error(`OCR worker unavailable at path: ${workerPath}`);
    }

    log.debug(`Creating OCR worker: ${workerPath}`);
    log.debug(
        `Tool paths: tesseract=${paths.tesseract}, pdftoppm=${paths.pdftoppm}, qpdf=${paths.qpdf}, popplerData=${paths.popplerDataDir || 'none'}, fontConfig=${paths.popplerFontConfigDir || 'none'}`,
    );

    return new Worker(workerPath, {workerData: {
        tesseractBinary: paths.tesseract,
        tessdataPath: paths.tessdata,
        pdftoppmBinary: paths.pdftoppm,
        pdftotextBinary: paths.pdftotext,
        pdfimagesBinary: paths.pdfimages,
        popplerDataDir: paths.popplerDataDir,
        popplerFontConfigDir: paths.popplerFontConfigDir,
        qpdfBinary: paths.qpdf,
        unpaperBinary: paths.unpaper,
        tempDir: getAppTempDir(),
    }});
}
