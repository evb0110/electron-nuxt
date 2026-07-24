import { shell } from 'electron';
import { uniq } from 'es-toolkit/array';
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
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { extractPages } from '@electron/features/page-ops/public';
import { getAppTempDir } from '@electron/utils/appTempDir';
import type {
    IDocumentsSenderIdContext,
    IDocumentsWindowContext,
} from '@electron/features/documents/documentsService';
import { resolveExistingReadablePdfPath } from '@electron/features/documents/main/documentFilePathResolution';
import { ensureWorkingCopyMaterialized } from '@electron/file-access/workingCopyMaterialization';
import {
    assertPdfPathWithinSizeLimit,
    cleanupPrintTempPath,
    openNativePrintDialogForPath,
    PRINT_DJVU_TEMP_PREFIX,
    schedulePrintTempCleanup,
    validatePdfBytesForHandoff,
    type IPrintPdfResult,
} from '@electron/utils/printHandoff';

const logger = createLogger('documents-print');
const DEFAULT_APP_TEMP_PREFIX = 'open-in-default-app-';
const PRINT_DATA_TEMP_PREFIX = 'print-data-';
const PRINT_PAGE_TEMP_PREFIX = 'print-pages-';
const DEFAULT_APP_TEMP_CLEANUP_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_APP_TEMP_MAX_AGE_MS = DEFAULT_APP_TEMP_CLEANUP_DELAY_MS;
const scheduledDefaultAppTempCleanup = new Map<string, ReturnType<typeof setTimeout>>();

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

function shouldSweepManagedTempPdf(entry: string) {
    if (extname(entry).toLowerCase() !== '.pdf') {
        return false;
    }

    return entry.startsWith(DEFAULT_APP_TEMP_PREFIX)
        || entry.startsWith(PRINT_DATA_TEMP_PREFIX)
        || entry.startsWith(PRINT_DJVU_TEMP_PREFIX)
        || entry.startsWith(PRINT_PAGE_TEMP_PREFIX);
}

export async function sweepStaleDefaultAppTempPdfs(maxAgeMs = DEFAULT_APP_TEMP_MAX_AGE_MS) {
    const tempDir = getAppTempDir();
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

async function resolveReadablePdfPathForSender(filePath: string, senderId?: number) {
    const resolvedPath = await resolveExistingReadablePdfPath(filePath, senderId);
    const materialized = await ensureWorkingCopyMaterialized(resolvedPath, {
        reason: 'print-external',
        ...(senderId === undefined ? {} : {ownerWebContentsId: senderId}),
    });
    await assertPdfPathWithinSizeLimit(materialized.physicalWorkingCopyPath);
    return materialized.physicalWorkingCopyPath;
}

function normalizePrintPageNumbers(pageNumbers?: number[]) {
    if (!Array.isArray(pageNumbers) || pageNumbers.length === 0) {
        return null;
    }

    const normalized = uniq(pageNumbers);
    if (normalized.some(pageNumber => !Number.isInteger(pageNumber) || pageNumber < 1)) {
        throw new Error('Invalid print page numbers');
    }

    return normalized.sort((left, right) => left - right);
}

export async function handlePrintPdfData(
    context: IDocumentsWindowContext,
    data: Uint8Array,
    fileName?: string,
): Promise<IPrintPdfResult> {
    validatePdfBytesForHandoff(data, 'print');

    const ownerWindow = context.window ?? undefined;
    const tempFileName = `${PRINT_DATA_TEMP_PREFIX}${randomUUID()}-${normalizePrintableFileName(fileName)}`;
    const tempPath = join(getAppTempDir(), tempFileName);
    let shouldRetainTempPdf = false;

    try {
        await writeFile(tempPath, Buffer.from(data));
        const result = await openNativePrintDialogForPath(ownerWindow, tempPath, {}, fileName);
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
    data: Uint8Array,
    fileName?: string,
): Promise<IOpenPdfInDefaultAppResult> {
    validatePdfBytesForHandoff(data, 'PDF handoff');

    const tempFileName = `${DEFAULT_APP_TEMP_PREFIX}${randomUUID()}-${normalizePrintableFileName(fileName)}`;
    const tempPath = join(getAppTempDir(), tempFileName);
    try {
        await writeFile(tempPath, Buffer.from(data));
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
    context: IDocumentsSenderIdContext,
    filePath: string,
    _fileName?: string,
): Promise<IOpenPdfInDefaultAppResult> {
    const resolvedPath = await resolveReadablePdfPathForSender(filePath, context.senderId);
    return openPdfInDefaultApp(resolvedPath);
}

export async function handlePrintPdfPath(
    context: IDocumentsWindowContext,
    filePath: string,
    _fileName?: string,
    pageNumbers?: number[],
): Promise<IPrintPdfResult> {
    const ownerWindow = context.window ?? undefined;
    const resolvedPath = await resolveReadablePdfPathForSender(filePath, context.senderId);
    const normalizedPageNumbers = normalizePrintPageNumbers(pageNumbers);
    if (!normalizedPageNumbers) {
        return openNativePrintDialogForPath(ownerWindow, resolvedPath, {}, _fileName);
    }

    const tempFileName = `${PRINT_PAGE_TEMP_PREFIX}${randomUUID()}-${normalizePrintableFileName(_fileName)}`;
    const tempPath = join(getAppTempDir(), tempFileName);
    let shouldRetainTempPdf = false;
    try {
        await extractPages(resolvedPath, tempPath, normalizedPageNumbers);
        const result = await openNativePrintDialogForPath(ownerWindow, tempPath, {pageRanges: [{
            from: 0,
            to: normalizedPageNumbers.length - 1,
        }]}, _fileName);
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
