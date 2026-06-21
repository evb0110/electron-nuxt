import {
    copyFile,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PDFDocument } from 'pdf-lib';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import { writePdfBookmarkOutlines } from '@pdf-core';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import {
    getPdfPageCount,
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/public';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const log = createLogger('djvu-bookmarks-native');
const NATIVE_DJVU_BOOKMARK_TIMEOUT_MS = 2 * 60 * 1000;

async function embedBookmarksIntoPdf(
    pdfData: Uint8Array,
    bookmarks: IPdfBookmarkEntry[],
) {
    if (bookmarks.length === 0) {
        return pdfData;
    }

    const doc = await PDFDocument.load(pdfData, { updateMetadata: false });
    writePdfBookmarkOutlines(doc, bookmarks);
    return new Uint8Array(await doc.save());
}

function createNativeBookmarkMutation(totalPages: number, bookmarks: IPdfBookmarkEntry[]) {
    const bookmarkMutation = {
        totalPages,
        untitledLabel: 'Untitled',
        items: bookmarks,
    };
    return {bookmarks: bookmarkMutation};
}

function padPdfDatePart(value: number, length = 2) {
    return String(value).padStart(length, '0');
}

function createNativeModifiedAt() {
    const date = new Date();
    return [
        'D:',
        padPdfDatePart(date.getUTCFullYear(), 4),
        padPdfDatePart(date.getUTCMonth() + 1),
        padPdfDatePart(date.getUTCDate()),
        padPdfDatePart(date.getUTCHours()),
        padPdfDatePart(date.getUTCMinutes()),
        padPdfDatePart(date.getUTCSeconds()),
        'Z',
    ].join('');
}

async function tryEmbedBookmarksWithNativePageOps(
    inputPdfPath: string,
    outputPdfPath: string,
    bookmarks: IPdfBookmarkEntry[],
    signal?: AbortSignal,
) {
    if (bookmarks.length === 0 || isNativePageOpsDisabled()) {
        return null;
    }

    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        return null;
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'djvu-bookmarks-'));
    const workingPath = join(tempDir, 'input.pdf');
    const mutationsPath = join(tempDir, 'bookmarks.json');

    try {
        const totalPages = await getPdfPageCount(inputPdfPath);
        await copyFile(inputPdfPath, workingPath);
        await copyFile(inputPdfPath, outputPdfPath);
        await writeFile(
            mutationsPath,
            JSON.stringify(createNativeBookmarkMutation(totalPages, bookmarks)),
            'utf8',
        );
        await runNativeToolCommand(binaryPath, [
            'save-mutations',
            '--input',
            workingPath,
            '--output',
            outputPdfPath,
            '--mutations-file',
            mutationsPath,
            '--modified-at',
            createNativeModifiedAt(),
            '--append',
        ], {
            timeoutMs: NATIVE_DJVU_BOOKMARK_TIMEOUT_MS,
            commandLabel: 'evb-pdf-page-ops(djvu-bookmarks)',
            ...(signal ? { signal } : {}),
        });
        const outputStats = await stat(outputPdfPath);
        return outputStats.size;
    } catch (error) {
        log.debug(`Native DjVu bookmark embedding failed, falling back to pdf-lib: ${getErrorMessage(error)}`);
        return null;
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}

export async function embedBookmarksIntoPdfFile(
    inputPdfPath: string,
    outputPdfPath: string,
    bookmarks: IPdfBookmarkEntry[],
    signal?: AbortSignal,
) {
    const nativeSize = await tryEmbedBookmarksWithNativePageOps(inputPdfPath, outputPdfPath, bookmarks, signal);
    if (nativeSize !== null) {
        return nativeSize;
    }

    const pdfData = await readFile(inputPdfPath);
    const updatedPdfData = await embedBookmarksIntoPdf(pdfData, bookmarks);
    await writeFile(outputPdfPath, updatedPdfData);
    const outputStats = await stat(outputPdfPath);
    return outputStats.size;
}
