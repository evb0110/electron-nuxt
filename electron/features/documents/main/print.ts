import {
    app,
    BrowserWindow,
    shell,
} from 'electron';
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
import { resolveAllowedReadPath } from '@electron/utils/path-validator';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('documents-print');
const PRINT_LOAD_SETTLE_DELAY_MS = 300;
const PRINT_WINDOW_WIDTH_PX = 1280;
const PRINT_WINDOW_HEIGHT_PX = 1600;
const DEFAULT_APP_TEMP_PREFIX = 'open-in-default-app-';
const DEFAULT_APP_TEMP_CLEANUP_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_APP_TEMP_MAX_AGE_MS = DEFAULT_APP_TEMP_CLEANUP_DELAY_MS;
const scheduledDefaultAppTempCleanup = new Map<string, ReturnType<typeof setTimeout>>();

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
        if (!entry.startsWith(DEFAULT_APP_TEMP_PREFIX) || extname(entry).toLowerCase() !== '.pdf') {
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
            // Historically this required sandbox:false; Electron 39 docs do not confirm that
            // sandbox:true is compatible with plugins:true for the PDF viewer, so we keep
            // sandbox disabled here to avoid regressing the print flow. Re-evaluate if Electron
            // documents PDF-viewer support under the default sandbox.
            sandbox: false,
            contextIsolation: true,
            nodeIntegration: false,
            plugins: true,
            backgroundThrottling: false,
        },
    });
}

async function runNativePrintDialog(printWindow: BrowserWindow): Promise<IPrintPdfResult> {
    return new Promise((resolve) => {
        printWindow.webContents.print(
            {
                silent: false,
                printBackground: true,
                margins: { marginType: 'printableArea' },
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
): Promise<IPrintPdfResult> {
    const printWindow = createPrintWindow(ownerWindow);

    try {
        await printWindow.loadURL(pathToFileURL(path).toString());
        await new Promise(resolve => setTimeout(resolve, PRINT_LOAD_SETTLE_DELAY_MS));
        return await runNativePrintDialog(printWindow);
    } catch (error) {
        logger.warn(`Failed to open native print dialog: ${getErrorMessage(error)}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to open native print dialog',
        };
    } finally {
        if (!printWindow.isDestroyed()) {
            printWindow.close();
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
    const tempFileName = `${randomUUID()}-${normalizePrintableFileName(fileName)}`;
    const tempPath = join(app.getPath('temp'), tempFileName);

    try {
        await writeFile(tempPath, toOwnedBuffer(data));
        return await openNativePrintDialogForPath(ownerWindow, tempPath);
    } finally {
        await unlink(tempPath).catch(() => undefined);
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
): Promise<IPrintPdfResult> {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const resolvedPath = await resolveAllowedPdfPath(filePath);
    return openNativePrintDialogForPath(ownerWindow, resolvedPath);
}
