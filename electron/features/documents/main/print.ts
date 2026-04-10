import {
    app,
    BrowserWindow,
} from 'electron';
import {
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
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('documents-print');
const PRINT_LOAD_SETTLE_DELAY_MS = 300;
const PRINT_WINDOW_WIDTH_PX = 1280;
const PRINT_WINDOW_HEIGHT_PX = 1600;

interface IPrintPdfResult {
    success: boolean;
    canceled?: boolean;
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
            sandbox: false,
            contextIsolation: true,
            nodeIntegration: false,
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
        logger.warn(`Failed to open native print dialog: ${error instanceof Error ? error.message : String(error)}`);
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

export function handlePrintPdfPath(
    event: Electron.IpcMainInvokeEvent,
    filePath: string,
    _fileName?: string,
): Promise<IPrintPdfResult> {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    return openNativePrintDialogForPath(ownerWindow, filePath);
}
