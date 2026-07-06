import {
    copyFile,
    mkdtemp,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/publicNative';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { embedBookmarksIntoPdfFileWithPdfLib } from '@electron/djvu/embedBookmarksIntoPdfFileWithPdfLib';
import { isAbortError } from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const log = createLogger('djvu-bookmarks-native');
const NATIVE_DJVU_BOOKMARK_TIMEOUT_MS = 2 * 60 * 1000;
const QPDF_DJVU_BOOKMARK_PAGE_COUNT_TIMEOUT_MS = 2 * 60 * 1000;
const QPDF_OUTPUT_SUCCESS_EXIT_CODES = [
    0,
    3,
];

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('Operation aborted', 'AbortError');
    }
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

async function getBookmarkInputPdfPageCount(inputPdfPath: string) {
    const result = await runNativeToolCommand(getPdfNativeToolPaths().qpdf, [
        '--show-npages',
        inputPdfPath,
    ], {
        timeoutMs: QPDF_DJVU_BOOKMARK_PAGE_COUNT_TIMEOUT_MS,
        allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
        commandLabel: 'qpdf(djvu-bookmark-page-count)',
    });
    const pageCount = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error('Failed to read PDF page count for DjVu bookmarks');
    }

    return pageCount;
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
        const totalPages = await getBookmarkInputPdfPageCount(inputPdfPath);
        throwIfAborted(signal);
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
        if (isAbortError(error)) {
            throw error;
        }
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

    return embedBookmarksIntoPdfFileWithPdfLib(inputPdfPath, outputPdfPath, bookmarks, signal);
}
