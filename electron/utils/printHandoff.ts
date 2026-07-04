import { BrowserWindow } from 'electron';
import type { WebContentsPrintOptions } from 'electron';
import {
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    basename,
    join,
    parse,
} from 'path';
import { pathToFileURL } from 'url';
import { delay } from 'es-toolkit/promise';
import { tmpdir } from 'os';
import { sortBy } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import { PDFDocument } from 'pdf-lib';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { buildPopplerEnv } from '@electron/native-tools/buildPopplerEnv';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';

const logger = createLogger('documents-print');
// Low-end Windows machines can report the PDF plugin as loaded before it has painted.
const PRINT_LOAD_SETTLE_DELAY_MS = 2_000;
const PRINT_JOB_RESOURCE_RETENTION_MS = 30_000;
const PRINT_DIALOG_TIMEOUT_MS = parseIntegerEnv('EVB_PRINT_DIALOG_TIMEOUT_MS', 5 * 60 * 1000, 5_000);
const PRINT_DIALOG_TEST_MODE_ENV = 'EVB_PRINT_DIALOG_TEST_MODE';
const PRINT_DIALOG_TEST_MODE_PRINT_TO_PDF = 'print-to-pdf';
const PRINT_DIALOG_TEST_OUTPUT_PATH_ENV = 'EVB_PRINT_DIALOG_TEST_OUTPUT_PATH';
const PRINT_WINDOW_WIDTH_PX = 1280;
const PRINT_WINDOW_HEIGHT_PX = 1600;
const PRINT_WINDOW_VISIBLE_ON_DARWIN = process.platform === 'darwin';
export const PRINT_DJVU_TEMP_PREFIX = 'print-djvu-';
const MAX_PRINT_PDF_BYTES = parseIntegerEnv('EVB_PRINT_PDF_MAX_MB', 256, 1, 2048) * 1024 * 1024;
const PRINT_RASTER_DPI = parseIntegerEnv('EVB_PRINT_RASTER_DPI', 180, 72, 300);
const PRINT_RASTER_CHUNK_PAGES = parseIntegerEnv('EVB_PRINT_RASTER_CHUNK_PAGES', 50, 1, 100);
const PRINT_RASTER_MAX_PAGES = parseIntegerEnv('EVB_PRINT_RASTER_MAX_PAGES', 2000, 1, 10000);
const PRINT_RASTER_RENDER_TIMEOUT_MS = parseIntegerEnv('EVB_PRINT_RASTER_TIMEOUT_MS', 3 * 60 * 1000, 5_000);
const PRINT_RASTER_IMAGE_LOAD_TIMEOUT_MS = parseIntegerEnv('EVB_PRINT_RASTER_IMAGE_LOAD_TIMEOUT_MS', 30_000, 1_000);
const PDF_HEADER_SCAN_BYTES = 1024;
const PDF_EOF_SCAN_BYTES = 1024 * 1024;
const scheduledPrintTempCleanup = new Map<string, ReturnType<typeof setTimeout>>();

export interface IPrintPdfResult {
    success: boolean;
    canceled?: boolean;
    error?: string;
}

export interface IPrintWindowContext {window?: BrowserWindow | null;}

interface IPrintHandoffOptions {
    signal?: AbortSignal;
    surface?: 'pdf-plugin' | 'rasterized-html';
}

interface IPdfPageSize {
    width: number;
    height: number;
}

interface IPdfPrintLayout {
    pageCount: number;
    firstPageSize: IPdfPageSize;
}

interface IPrintImagePage {
    pageNumber: number;
    path: string;
}

function includesAsciiToken(data: Uint8Array, token: string, start: number, end: number) {
    const tokenBytes = Buffer.from(token, 'ascii');
    const lastStart = end - tokenBytes.byteLength;
    for (let offset = start; offset <= lastStart; offset += 1) {
        let matches = true;
        for (let index = 0; index < tokenBytes.byteLength; index += 1) {
            if (data[offset + index] !== tokenBytes[index]) {
                matches = false;
                break;
            }
        }
        if (matches) {
            return true;
        }
    }
    return false;
}

export function validatePdfBytesForHandoff(data: Uint8Array, label: string) {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        throw new Error(`Invalid ${label} payload`);
    }
    if (data.byteLength > MAX_PRINT_PDF_BYTES) {
        throw new Error(`${label} payload is too large`);
    }

    const headerEnd = Math.min(data.byteLength, PDF_HEADER_SCAN_BYTES);
    const eofStart = Math.max(0, data.byteLength - PDF_EOF_SCAN_BYTES);
    if (
        !includesAsciiToken(data, '%PDF-', 0, headerEnd)
        || !includesAsciiToken(data, '%%EOF', eofStart, data.byteLength)
    ) {
        throw new Error(`${label} payload is not a valid PDF`);
    }
}

export async function assertPdfPathWithinSizeLimit(filePath: string) {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
        throw new Error('Invalid PDF path');
    }
    if (fileStat.size > MAX_PRINT_PDF_BYTES) {
        throw new Error('PDF file is too large');
    }
}

export function schedulePrintTempCleanup(path: string, delayMs = PRINT_JOB_RESOURCE_RETENTION_MS) {
    const existingTimer = scheduledPrintTempCleanup.get(path);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
        scheduledPrintTempCleanup.delete(path);
        void unlink(path).catch(() => undefined);
    }, delayMs);
    timer.unref?.();
    scheduledPrintTempCleanup.set(path, timer);
}

export async function cleanupPrintTempPath(path: string) {
    const existingTimer = scheduledPrintTempCleanup.get(path);
    if (existingTimer) {
        clearTimeout(existingTimer);
        scheduledPrintTempCleanup.delete(path);
    }

    await unlink(path).catch(() => undefined);
}

function sanitizePrintDocumentTitle(title: string) {
    const sanitized = Array.from(title)
        .map((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            if (codePoint < 32 || character === '/' || character === '\\' || character === ':') {
                return '-';
            }
            return character;
        })
        .join('')
        .trim();
    return sanitized || 'document';
}

function resolvePrintDocumentTitle(filePath: string, fileName?: string) {
    const candidate = typeof fileName === 'string' && fileName.trim()
        ? fileName.trim()
        : filePath;
    const candidateBaseName = basename(candidate) || 'document';
    const parsed = parse(candidateBaseName);
    return sanitizePrintDocumentTitle(parsed.name || candidateBaseName || 'document');
}

function createPrintWindow(ownerWindow: BrowserWindow | undefined, documentTitle: string) {
    return new BrowserWindow({
        show: false,
        title: documentTitle,
        autoHideMenuBar: true,
        ...(ownerWindow ? { parent: ownerWindow } : {}),
        width: PRINT_WINDOW_WIDTH_PX,
        height: PRINT_WINDOW_HEIGHT_PX,
        skipTaskbar: true,
        minimizable: false,
        fullscreenable: false,
        paintWhenInitiallyHidden: true,
        backgroundColor: '#ffffff',
        webPreferences: {
            // 'plugins: true' enables Chromium's built-in PDF viewer for native print preview.
            // The window has no preload and no Node API exposure, so this sandbox flip is a
            // pure defense-in-depth tightening; if the Chromium PDF plugin fails to render
            // under the sandbox in this Electron version, revert to sandbox:false.
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            plugins: true,
            backgroundThrottling: false,
        },
    });
}

function escapeHtml(value: string) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizePdfPageSize(rawSize: {
    height?: unknown;
    width?: unknown;
} | undefined): IPdfPageSize {
    const width = typeof rawSize?.width === 'number' && Number.isFinite(rawSize.width) && rawSize.width > 0
        ? rawSize.width
        : 612;
    const height = typeof rawSize?.height === 'number' && Number.isFinite(rawSize.height) && rawSize.height > 0
        ? rawSize.height
        : 792;
    return {
        width,
        height,
    };
}

async function readPdfPrintLayout(path: string): Promise<IPdfPrintLayout> {
    const pdfData = await readFile(path);
    const pdfDocument = await PDFDocument.load(pdfData, {updateMetadata: false});
    const pageCount = pdfDocument.getPageCount();
    if (!Number.isInteger(pageCount) || pageCount < 1) {
        throw new Error('Printable PDF has no pages');
    }
    if (pageCount > PRINT_RASTER_MAX_PAGES) {
        throw new Error(`Native print handoff is capped at ${PRINT_RASTER_MAX_PAGES} pages`);
    }

    const firstPage = pdfDocument.getPage(0);
    return {
        pageCount,
        firstPageSize: normalizePdfPageSize(firstPage.getSize()),
    };
}

function parseRenderedImagePageNumber(fileName: string) {
    const match = fileName.match(/-(\d+)\.(?:jpe?g)$/iu);
    if (!match) {
        return Number.POSITIVE_INFINITY;
    }
    return Number.parseInt(match[1] ?? '', 10);
}

function isRenderedPrintImage(fileName: string, prefixBaseName: string) {
    return fileName.startsWith(`${prefixBaseName}-`) && /\.(?:jpe?g)$/iu.test(fileName);
}

async function renderPdfPrintImages(
    pdfPath: string,
    layout: IPdfPrintLayout,
    workDir: string,
    signal?: AbortSignal,
) {
    const paths = getPdfNativeToolPaths();
    const popplerEnv = buildPopplerEnv(paths);
    const renderedPages: IPrintImagePage[] = [];

    for (const firstPage of range(1, layout.pageCount + 1, PRINT_RASTER_CHUNK_PAGES)) {
        throwIfPrintHandoffAborted(signal);
        const lastPage = Math.min(layout.pageCount, firstPage + PRINT_RASTER_CHUNK_PAGES - 1);
        const prefixBaseName = `page-${String(firstPage).padStart(5, '0')}`;
        const prefix = join(workDir, prefixBaseName);
        const commandOptions: Parameters<typeof runNativeToolCommand>[2] = {
            timeoutMs: PRINT_RASTER_RENDER_TIMEOUT_MS,
            commandLabel: 'pdftoppm(print-raster)',
            ...(signal ? { signal } : {}),
        };
        if (popplerEnv !== undefined) {
            commandOptions.env = popplerEnv;
        }

        await runNativeToolCommand(paths.pdftoppm, [
            '-jpeg',
            '-r',
            String(PRINT_RASTER_DPI),
            '-f',
            String(firstPage),
            '-l',
            String(lastPage),
            pdfPath,
            prefix,
        ], commandOptions);
        throwIfPrintHandoffAborted(signal);

        const fileNames = await readdir(workDir);
        renderedPages.push(...sortBy(
            fileNames
                .filter(fileName => isRenderedPrintImage(fileName, prefixBaseName))
                .map(fileName => ({
                    pageNumber: parseRenderedImagePageNumber(fileName),
                    path: join(workDir, fileName),
                })),
            ['pageNumber'],
        ));
    }

    if (renderedPages.length !== layout.pageCount) {
        throw new Error(`Expected ${layout.pageCount} printable page image(s), rendered ${renderedPages.length}`);
    }

    return renderedPages;
}

function buildRasterPrintHtml(
    title: string,
    layout: IPdfPrintLayout,
    imagePages: IPrintImagePage[],
) {
    const pageWidth = Math.max(1, layout.firstPageSize.width);
    const pageHeight = Math.max(1, layout.firstPageSize.height);
    const escapedTitle = escapeHtml(title);
    const pagesHtml = imagePages.map(page => `
        <section class="print-page" data-page-number="${page.pageNumber}">
            <img src="${escapeHtml(pathToFileURL(page.path).toString())}" alt="">
        </section>
    `).join('');

    return `<!doctype html>
<html>
<head>
    <meta charset="utf-8">
    <title>${escapedTitle}</title>
    <style>
        @page {
            size: ${pageWidth.toFixed(2)}pt ${pageHeight.toFixed(2)}pt;
            margin: 0;
        }
        html,
        body {
            margin: 0;
            padding: 0;
            background: #fff;
        }
        .print-page {
            box-sizing: border-box;
            width: ${pageWidth.toFixed(2)}pt;
            height: ${pageHeight.toFixed(2)}pt;
            margin: 0;
            overflow: hidden;
            break-after: page;
            page-break-after: always;
            background: #fff;
        }
        .print-page:last-child {
            break-after: auto;
            page-break-after: auto;
        }
        .print-page img {
            display: block;
            width: 100%;
            height: 100%;
            object-fit: contain;
        }
    </style>
</head>
<body>${pagesHtml}</body>
</html>`;
}

async function waitForRasterPrintSurfaceReady(printWindow: BrowserWindow) {
    await printWindow.webContents.executeJavaScript(`
        (() => {
            const timeoutMs = ${PRINT_RASTER_IMAGE_LOAD_TIMEOUT_MS};
            const waitForImage = (image) => {
                if (image.complete && image.naturalWidth > 0) {
                    return Promise.resolve(true);
                }
                if (typeof image.decode === 'function') {
                    return image.decode().then(() => {
                        if (image.naturalWidth <= 0) {
                            throw new Error('Printable page image decoded without dimensions');
                        }
                        return true;
                    });
                }
                return new Promise((resolve, reject) => {
                    image.addEventListener('load', () => resolve(true), {once: true});
                    image.addEventListener('error', () => reject(new Error('Printable page image failed to load')), {once: true});
                });
            };
            return Promise.race([
                Promise.all(Array.from(document.images).map(waitForImage)).then(() => true),
                new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Timed out loading printable page images')), timeoutMs);
                }),
            ]);
        })()
    `, true);
}

async function createRasterPrintHtmlPath(path: string, documentTitle: string, signal?: AbortSignal) {
    const workDir = await mkdtemp(join(tmpdir(), 'evb-print-raster-'));
    try {
        throwIfPrintHandoffAborted(signal);
        const layout = await readPdfPrintLayout(path);
        throwIfPrintHandoffAborted(signal);
        const imagePages = await renderPdfPrintImages(path, layout, workDir, signal);
        throwIfPrintHandoffAborted(signal);
        const htmlPath = join(workDir, 'print.html');
        await writeFile(htmlPath, buildRasterPrintHtml(documentTitle, layout, imagePages), 'utf8');
        return {
            htmlPath,
            workDir,
        };
    } catch (error) {
        await rm(workDir, {
            force: true,
            recursive: true,
        }).catch(() => undefined);
        throw error;
    }
}

function throwIfPrintHandoffAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        const error = new Error('Print handoff canceled');
        error.name = 'AbortError';
        throw error;
    }
}

function isPrintHandoffAbort(error: unknown) {
    return error instanceof Error && error.name === 'AbortError';
}

function lockPrintWindowTitle(printWindow: BrowserWindow, documentTitle: string) {
    printWindow.setTitle(documentTitle);
    const handlePageTitleUpdated = (event: Electron.Event) => {
        event.preventDefault();
        printWindow.setTitle(documentTitle);
    };
    printWindow.webContents.on('page-title-updated', handlePageTitleUpdated);

    return () => {
        printWindow.webContents.removeListener('page-title-updated', handlePageTitleUpdated);
    };
}

function revealPrintWindowForNativeDialog(printWindow: BrowserWindow) {
    if (!PRINT_WINDOW_VISIBLE_ON_DARWIN || shouldRunPrintToPdfSmoke()) {
        return;
    }

    // macOS can hand a blank hidden PDF plugin surface to the native print dialog.
    // Showing the transient print window gives Chromium's PDF viewer a real surface
    // while the dialog is open; the window is hidden again after the print callback.
    printWindow.showInactive();
}

function hideRevealedPrintWindow(printWindow: BrowserWindow) {
    if (PRINT_WINDOW_VISIBLE_ON_DARWIN && !printWindow.isDestroyed()) {
        printWindow.hide();
    }
}

function closePrintWindow(printWindow: BrowserWindow) {
    if (!printWindow.isDestroyed()) {
        printWindow.close();
    }
}

function schedulePrintWindowClose(printWindow: BrowserWindow, delayMs = PRINT_JOB_RESOURCE_RETENTION_MS) {
    const timer = setTimeout(() => {
        closePrintWindow(printWindow);
    }, delayMs);
    timer.unref?.();
}

function shouldRunPrintToPdfSmoke() {
    return process.env[PRINT_DIALOG_TEST_MODE_ENV]?.trim() === PRINT_DIALOG_TEST_MODE_PRINT_TO_PDF;
}

async function runPrintToPdfSmoke(printWindow: BrowserWindow): Promise<IPrintPdfResult> {
    try {
        const data = await printWindow.webContents.printToPDF({printBackground: true});
        validatePdfBytesForHandoff(data, 'print smoke');
        const outputPath = process.env[PRINT_DIALOG_TEST_OUTPUT_PATH_ENV]?.trim();
        if (outputPath) {
            await writeFile(outputPath, data);
        }
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: getErrorMessage(error),
        };
    }
}

function runNativePrintDialog(
    printWindow: BrowserWindow,
    printOptions: WebContentsPrintOptions = {},
): Promise<IPrintPdfResult> {
    if (shouldRunPrintToPdfSmoke()) {
        return runPrintToPdfSmoke(printWindow);
    }

    return new Promise((resolve) => {
        let settled = false;
        const timeout = setTimeout(() => {
            finish({
                success: false,
                error: `Print dialog timed out after ${PRINT_DIALOG_TIMEOUT_MS}ms`,
            });
        }, PRINT_DIALOG_TIMEOUT_MS);
        timeout.unref?.();

        const handleClosed = () => {
            finish({
                success: false,
                error: 'Print window closed before the native dialog completed',
            });
        };
        const handleRendererGone = () => {
            finish({
                success: false,
                error: 'Print renderer exited before the native dialog completed',
            });
        };
        const cleanup = () => {
            clearTimeout(timeout);
            printWindow.removeListener('closed', handleClosed);
            printWindow.webContents.removeListener('render-process-gone', handleRendererGone);
            printWindow.webContents.removeListener('destroyed', handleClosed);
        };
        function finish(result: IPrintPdfResult) {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(result);
        }

        printWindow.once('closed', handleClosed);
        printWindow.webContents.once('render-process-gone', handleRendererGone);
        printWindow.webContents.once('destroyed', handleClosed);

        try {
            printWindow.webContents.print(
                {
                    silent: false,
                    printBackground: true,
                    margins: { marginType: 'printableArea' },
                    ...printOptions,
                },
                (success, failureReason) => {
                    if (success) {
                        finish({ success: true });
                        return;
                    }

                    const normalizedReason = (failureReason ?? '').trim();
                    if (normalizedReason.toLowerCase().includes('cancel')) {
                        finish({
                            success: false,
                            canceled: true,
                            ...(normalizedReason ? { error: normalizedReason } : {}),
                        });
                        return;
                    }

                    finish({
                        success: false,
                        error: normalizedReason || 'Print failed',
                    });
                },
            );
        } catch (error) {
            finish({
                success: false,
                error: getErrorMessage(error),
            });
        }
    });
}

export async function openNativePrintDialogForPath(
    ownerWindow: BrowserWindow | undefined,
    path: string,
    printOptions: WebContentsPrintOptions = {},
    fileName?: string,
    handoffOptions: IPrintHandoffOptions = {},
): Promise<IPrintPdfResult> {
    const documentTitle = resolvePrintDocumentTitle(path, fileName);
    const shouldUseRasterSurface = handoffOptions.surface === 'rasterized-html';
    let rasterSurface: Awaited<ReturnType<typeof createRasterPrintHtmlPath>> | null = null;
    const printWindow = createPrintWindow(ownerWindow, documentTitle);
    const releasePrintWindowTitle = lockPrintWindowTitle(printWindow, documentTitle);
    let shouldRetainPrintWindow = false;
    const closeForAbort = () => {
        closePrintWindow(printWindow);
    };
    handoffOptions.signal?.addEventListener('abort', closeForAbort, { once: true });

    try {
        throwIfPrintHandoffAborted(handoffOptions.signal);
        rasterSurface = shouldUseRasterSurface
            ? await createRasterPrintHtmlPath(path, documentTitle, handoffOptions.signal)
            : null;
        throwIfPrintHandoffAborted(handoffOptions.signal);
        await printWindow.loadURL(rasterSurface ? pathToFileURL(rasterSurface.htmlPath).toString() : pathToFileURL(path).toString());
        throwIfPrintHandoffAborted(handoffOptions.signal);
        if (!rasterSurface) {
            revealPrintWindowForNativeDialog(printWindow);
        } else {
            await waitForRasterPrintSurfaceReady(printWindow);
        }
        throwIfPrintHandoffAborted(handoffOptions.signal);
        await delay(PRINT_LOAD_SETTLE_DELAY_MS);
        throwIfPrintHandoffAborted(handoffOptions.signal);
        const result = await runNativePrintDialog(printWindow, printOptions);
        if (handoffOptions.signal?.aborted) {
            return {
                success: false,
                canceled: true,
                error: 'Print handoff canceled',
            };
        }
        if (result.success) {
            shouldRetainPrintWindow = true;
            if (!rasterSurface) {
                hideRevealedPrintWindow(printWindow);
            }
            schedulePrintWindowClose(printWindow);
        }
        return result;
    } catch (error) {
        if (isPrintHandoffAbort(error) || handoffOptions.signal?.aborted) {
            return {
                success: false,
                canceled: true,
                error: 'Print handoff canceled',
            };
        }
        logger.warn(`Failed to open native print dialog: ${getErrorMessage(error)}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to open native print dialog',
        };
    } finally {
        handoffOptions.signal?.removeEventListener('abort', closeForAbort);
        releasePrintWindowTitle();
        if (!shouldRetainPrintWindow) {
            closePrintWindow(printWindow);
        }
        if (rasterSurface) {
            scheduleRasterSurfaceCleanup(rasterSurface.workDir);
        }
    }
}

export async function printManagedTempPdfPath(
    context: IPrintWindowContext,
    filePath: string,
    fileName?: string,
    handoffOptions: IPrintHandoffOptions = {},
): Promise<IPrintPdfResult> {
    const ownerWindow = context.window ?? undefined;
    let shouldRetainTempPdf = false;
    try {
        await assertPdfPathWithinSizeLimit(filePath);
        const result = await openNativePrintDialogForPath(ownerWindow, filePath, {}, fileName, handoffOptions);
        if (result.success) {
            shouldRetainTempPdf = true;
            schedulePrintTempCleanup(filePath);
        }
        return result;
    } finally {
        if (!shouldRetainTempPdf) {
            await cleanupPrintTempPath(filePath);
        }
    }
}

function scheduleRasterSurfaceCleanup(path: string, delayMs = PRINT_JOB_RESOURCE_RETENTION_MS) {
    const timer = setTimeout(() => {
        void rm(path, {
            force: true,
            recursive: true,
        }).catch(() => undefined);
    }, delayMs);
    timer.unref?.();
}
