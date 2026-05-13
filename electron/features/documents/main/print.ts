import {
    app,
    BrowserWindow,
    shell,
} from 'electron';
import type { WebContentsPrintOptions } from 'electron';
import {
    readdir,
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    basename,
    extname,
    join,
} from 'path';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import { resolveAllowedReadPath } from '@electron/utils/pathValidator';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';
import { extractPages } from '@electron/features/page-ops/public';

const logger = createLogger('documents-print');
// Low-end Windows machines can report the PDF plugin as loaded before it has painted.
const PRINT_LOAD_SETTLE_DELAY_MS = 2_000;
const PRINT_JOB_RESOURCE_RETENTION_MS = 30_000;
const PRINT_WINDOW_WIDTH_PX = 1280;
const PRINT_WINDOW_HEIGHT_PX = 1600;
const DEFAULT_APP_TEMP_PREFIX = 'open-in-default-app-';
const PRINT_DATA_TEMP_PREFIX = 'print-data-';
const PRINT_PAGE_TEMP_PREFIX = 'print-pages-';
const DEFAULT_APP_TEMP_CLEANUP_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_APP_TEMP_MAX_AGE_MS = DEFAULT_APP_TEMP_CLEANUP_DELAY_MS;
const scheduledDefaultAppTempCleanup = new Map<string, ReturnType<typeof setTimeout>>();
const scheduledPrintTempCleanup = new Map<string, ReturnType<typeof setTimeout>>();

interface IPrintPdfResult {
    success: boolean;
    canceled?: boolean;
    error?: string;
}

interface IOpenPdfInDefaultAppResult {
    success: boolean;
    error?: string;
}

function normalizePrintableFileName(fileName?: string) {
    const trimmed = typeof fileName === 'string' ? fileName.trim() : '';
    const safeBaseName = Array.from(basename(trimmed || 'document.pdf'))
        .map((character) => {
            if (/[<>:"/\\|?*]/.test(character)) {
                return '-';
            }

            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint < 32 ? '-' : character;
        })
        .join('');
    if (extname(safeBaseName).toLowerCase() === '.pdf') {
        return safeBaseName;
    }
    return `${safeBaseName || 'document'}.pdf`;
}

function toOwnedBuffer(data: Uint8Array) {
    return Buffer.from(data);
}

function scheduleDefaultAppTempCleanup(path: string, delayMs = DEFAULT_APP_TEMP_CLEANUP_DELAY_MS) {
    const existingTimer = scheduledDefaultAppTempCleanup.get(path);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
        scheduledDefaultAppTempCleanup.delete(path);
        void unlink(path).catch(() => undefined);
    }, delayMs);
    timer.unref?.();
    scheduledDefaultAppTempCleanup.set(path, timer);
}

async function cleanupDefaultAppTempPath(path: string) {
    const existingTimer = scheduledDefaultAppTempCleanup.get(path);
    if (existingTimer) {
        clearTimeout(existingTimer);
        scheduledDefaultAppTempCleanup.delete(path);
    }

    await unlink(path).catch(() => undefined);
}

function schedulePrintTempCleanup(path: string, delayMs = PRINT_JOB_RESOURCE_RETENTION_MS) {
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

async function cleanupPrintTempPath(path: string) {
    const existingTimer = scheduledPrintTempCleanup.get(path);
    if (existingTimer) {
        clearTimeout(existingTimer);
        scheduledPrintTempCleanup.delete(path);
    }

    await unlink(path).catch(() => undefined);
}

function shouldSweepManagedTempPdf(entry: string) {
    if (extname(entry).toLowerCase() !== '.pdf') {
        return false;
    }

    return entry.startsWith(DEFAULT_APP_TEMP_PREFIX)
        || entry.startsWith(PRINT_DATA_TEMP_PREFIX)
        || entry.startsWith(PRINT_PAGE_TEMP_PREFIX);
}

export async function sweepStaleDefaultAppTempPdfs(maxAgeMs = DEFAULT_APP_TEMP_MAX_AGE_MS) {
    const tempDir = app.getPath('temp');
    const now = Date.now();

    let entries: string[] = [];
    try {
        entries = await readdir(tempDir);
    } catch {
        return;
    }

    await Promise.all(entries.map(async (entry) => {
        if (!shouldSweepManagedTempPdf(entry)) {
            return;
        }

        const path = join(tempDir, entry);
        try {
            const fileStat = await stat(path);
            const lastTouchedAt = Math.max(fileStat.mtimeMs, fileStat.ctimeMs);
            if (!Number.isFinite(lastTouchedAt) || now - lastTouchedAt < maxAgeMs) {
                return;
            }
        } catch {
            return;
        }

        await cleanupDefaultAppTempPath(path);
        await cleanupPrintTempPath(path);
    }));
}

async function openPdfInDefaultApp(path: string): Promise<IOpenPdfInDefaultAppResult> {
    try {
        const result = await shell.openPath(path);
        if (!result) {
            return { success: true };
        }

        return {
            success: false,
            error: result,
        };
    } catch (error) {
        logger.warn(`Failed to open PDF in the default app: ${getErrorMessage(error)}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to open the default PDF app',
        };
    }
}

async function resolveAllowedPdfPath(filePath: string) {
    const resolvedPath = await resolveAllowedReadPath(filePath);
    if (!resolvedPath || extname(resolvedPath).toLowerCase() !== '.pdf') {
        throw new Error('Invalid PDF path');
    }
    return resolvedPath;
}

function normalizePrintPageNumbers(pageNumbers?: number[]) {
    if (!Array.isArray(pageNumbers) || pageNumbers.length === 0) {
        return null;
    }

    const normalized = Array.from(new Set(pageNumbers));
    if (normalized.some(pageNumber => !Number.isInteger(pageNumber) || pageNumber < 1)) {
        throw new Error('Invalid print page numbers');
    }

    return normalized.sort((left, right) => left - right);
}

function createPrintWindow(ownerWindow?: BrowserWindow) {
    return new BrowserWindow({
        show: false,
        autoHideMenuBar: true,
        parent: ownerWindow,
        width: PRINT_WINDOW_WIDTH_PX,
        height: PRINT_WINDOW_HEIGHT_PX,
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

async function runNativePrintDialog(
    printWindow: BrowserWindow,
    printOptions: WebContentsPrintOptions = {},
): Promise<IPrintPdfResult> {
    return new Promise((resolve) => {
        printWindow.webContents.print(
            {
                silent: false,
                printBackground: true,
                margins: { marginType: 'printableArea' },
                ...printOptions,
            },
            (success, failureReason) => {
                if (success) {
                    resolve({ success: true });
                    return;
                }

                const normalizedReason = (failureReason ?? '').trim();
                if (normalizedReason.toLowerCase().includes('cancel')) {
                    resolve({
                        success: false,
                        canceled: true,
                        error: normalizedReason || undefined,
                    });
                    return;
                }

                resolve({
                    success: false,
                    error: normalizedReason || 'Print failed',
                });
            },
        );
    });
}

async function openNativePrintDialogForPath(
    ownerWindow: BrowserWindow | undefined,
    path: string,
    printOptions: WebContentsPrintOptions = {},
): Promise<IPrintPdfResult> {
    const printWindow = createPrintWindow(ownerWindow);
    let shouldRetainPrintWindow = false;

    try {
        await printWindow.loadURL(pathToFileURL(path).toString());
        await new Promise(resolve => setTimeout(resolve, PRINT_LOAD_SETTLE_DELAY_MS));
        const result = await runNativePrintDialog(printWindow, printOptions);
        if (result.success) {
            shouldRetainPrintWindow = true;
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
        if (!shouldRetainPrintWindow) {
            closePrintWindow(printWindow);
        }
    }
}

export async function handlePrintPdfData(
    event: Electron.IpcMainInvokeEvent,
    data: Uint8Array,
    fileName?: string,
): Promise<IPrintPdfResult> {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        throw new Error('Invalid print payload');
    }

    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const tempFileName = `${PRINT_DATA_TEMP_PREFIX}${randomUUID()}-${normalizePrintableFileName(fileName)}`;
    const tempPath = join(app.getPath('temp'), tempFileName);
    let shouldRetainTempPdf = false;

    try {
        await writeFile(tempPath, toOwnedBuffer(data));
        const result = await openNativePrintDialogForPath(ownerWindow, tempPath);
        if (result.success) {
            shouldRetainTempPdf = true;
            schedulePrintTempCleanup(tempPath);
        }
        return result;
    } finally {
        if (!shouldRetainTempPdf) {
            await cleanupPrintTempPath(tempPath);
        }
    }
}

export async function handleOpenPdfInDefaultAppData(
    _event: Electron.IpcMainInvokeEvent,
    data: Uint8Array,
    fileName?: string,
): Promise<IOpenPdfInDefaultAppResult> {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        throw new Error('Invalid PDF handoff payload');
    }

    const tempFileName = `${DEFAULT_APP_TEMP_PREFIX}${randomUUID()}-${normalizePrintableFileName(fileName)}`;
    const tempPath = join(app.getPath('temp'), tempFileName);
    try {
        await writeFile(tempPath, toOwnedBuffer(data));
        const result = await openPdfInDefaultApp(tempPath);
        if (result.success) {
            scheduleDefaultAppTempCleanup(tempPath);
            return result;
        }

        await cleanupDefaultAppTempPath(tempPath);
        return result;
    } catch (error) {
        await cleanupDefaultAppTempPath(tempPath);
        throw error;
    }
}

export async function handleOpenPdfInDefaultAppPath(
    _event: Electron.IpcMainInvokeEvent,
    filePath: string,
    _fileName?: string,
): Promise<IOpenPdfInDefaultAppResult> {
    const resolvedPath = await resolveAllowedPdfPath(filePath);
    return openPdfInDefaultApp(resolvedPath);
}

export async function handlePrintPdfPath(
    event: Electron.IpcMainInvokeEvent,
    filePath: string,
    _fileName?: string,
    pageNumbers?: number[],
): Promise<IPrintPdfResult> {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const resolvedPath = await resolveAllowedPdfPath(filePath);
    const normalizedPageNumbers = normalizePrintPageNumbers(pageNumbers);
    if (!normalizedPageNumbers) {
        return openNativePrintDialogForPath(ownerWindow, resolvedPath);
    }

    const tempFileName = `${PRINT_PAGE_TEMP_PREFIX}${randomUUID()}-${normalizePrintableFileName(_fileName)}`;
    const tempPath = join(app.getPath('temp'), tempFileName);
    let shouldRetainTempPdf = false;
    try {
        await extractPages(resolvedPath, tempPath, normalizedPageNumbers);
        const result = await openNativePrintDialogForPath(ownerWindow, tempPath, {pageRanges: [{
            from: 0,
            to: normalizedPageNumbers.length - 1,
        }]});
        if (result.success) {
            shouldRetainTempPdf = true;
            schedulePrintTempCleanup(tempPath);
        }
        return result;
    } finally {
        if (!shouldRetainTempPdf) {
            await cleanupPrintTempPath(tempPath);
        }
    }
}
