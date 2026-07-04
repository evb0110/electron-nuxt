import { BrowserWindow } from 'electron';
import type { WebContentsPrintOptions } from 'electron';
import {
    stat,
    unlink,
} from 'fs/promises';
import {
    basename,
    parse,
} from 'path';
import { pathToFileURL } from 'url';
import { delay } from 'es-toolkit/promise';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';

const logger = createLogger('documents-print');
// Low-end Windows machines can report the PDF plugin as loaded before it has painted.
const PRINT_LOAD_SETTLE_DELAY_MS = 2_000;
const PRINT_JOB_RESOURCE_RETENTION_MS = 30_000;
const PRINT_DIALOG_TIMEOUT_MS = parseIntegerEnv('EVB_PRINT_DIALOG_TIMEOUT_MS', 5 * 60 * 1000, 5_000);
const PRINT_DIALOG_TEST_MODE_ENV = 'EVB_PRINT_DIALOG_TEST_MODE';
const PRINT_DIALOG_TEST_MODE_PRINT_TO_PDF = 'print-to-pdf';
const PRINT_WINDOW_WIDTH_PX = 1280;
const PRINT_WINDOW_HEIGHT_PX = 1600;
const PRINT_WINDOW_VISIBLE_ON_DARWIN = process.platform === 'darwin';
export const PRINT_DJVU_TEMP_PREFIX = 'print-djvu-';
const MAX_PRINT_PDF_BYTES = parseIntegerEnv('EVB_PRINT_PDF_MAX_MB', 256, 1, 2048) * 1024 * 1024;
const PDF_HEADER_SCAN_BYTES = 1024;
const PDF_EOF_SCAN_BYTES = 1024 * 1024;
const scheduledPrintTempCleanup = new Map<string, ReturnType<typeof setTimeout>>();

export interface IPrintPdfResult {
    success: boolean;
    canceled?: boolean;
    error?: string;
}

export interface IPrintWindowContext {window?: BrowserWindow | null;}

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

export function resolvePrintDocumentTitle(filePath: string, fileName?: string) {
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
): Promise<IPrintPdfResult> {
    const documentTitle = resolvePrintDocumentTitle(path, fileName);
    const printWindow = createPrintWindow(ownerWindow, documentTitle);
    const releasePrintWindowTitle = lockPrintWindowTitle(printWindow, documentTitle);
    let shouldRetainPrintWindow = false;

    try {
        await printWindow.loadURL(pathToFileURL(path).toString());
        revealPrintWindowForNativeDialog(printWindow);
        await delay(PRINT_LOAD_SETTLE_DELAY_MS);
        const result = await runNativePrintDialog(printWindow, printOptions);
        if (result.success) {
            shouldRetainPrintWindow = true;
            hideRevealedPrintWindow(printWindow);
            schedulePrintWindowClose(printWindow);
        }
        return result;
    } catch (error) {
        logger.warn(`Failed to open native print dialog: ${getErrorMessage(error)}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to open native print dialog',
        };
    } finally {
        releasePrintWindowTitle();
        if (!shouldRetainPrintWindow) {
            closePrintWindow(printWindow);
        }
    }
}

export async function printManagedTempPdfPath(
    context: IPrintWindowContext,
    filePath: string,
    fileName?: string,
): Promise<IPrintPdfResult> {
    await assertPdfPathWithinSizeLimit(filePath);
    const ownerWindow = context.window ?? undefined;
    let shouldRetainTempPdf = false;
    try {
        const result = await openNativePrintDialogForPath(ownerWindow, filePath, {}, fileName);
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
