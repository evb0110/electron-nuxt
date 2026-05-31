import {
    mkdtemp,
    rm,
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runNativeToolCommand } from '@electron/native-tools/exec';
import { getNativeToolPaths } from '@electron/native-tools/paths';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';
import { isErrnoException } from '@contracts/runtimeGuards';
import {
    cleanupTempOutput,
    makeTempPdfOutputPath,
    replaceTempOutput,
} from '@electron/features/page-ops/main/tempOutput';
import { ensureWorkingCopyDirectory } from '@electron/ipc/workingCopyCreation';

const log = createLogger('page-ops-qpdf');
export const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
// qpdf exits with 3 when it completed the write but found warnings in the input.
export const QPDF_OUTPUT_SUCCESS_EXIT_CODES = [
    0,
    3,
];

function getQpdfBinary() {
    return getNativeToolPaths().qpdf;
}

function buildComplementRanges(pagesToRemove: number[], totalPages: number) {
    const removeSet = new Set(pagesToRemove);
    const kept: number[] = [];
    for (let i = 1; i <= totalPages; i++) {
        if (!removeSet.has(i)) {
            kept.push(i);
        }
    }
    return kept;
}

function formatPageList(pages: number[]) {
    const ranges: string[] = [];
    let rangeStart: number | null = null;
    let previous: number | null = null;

    for (const page of pages) {
        if (rangeStart === null || previous === null) {
            rangeStart = page;
            previous = page;
            continue;
        }

        if (page === previous + 1) {
            previous = page;
            continue;
        }

        ranges.push(rangeStart === previous ? String(rangeStart) : `${rangeStart}-${previous}`);
        rangeStart = page;
        previous = page;
    }

    if (rangeStart !== null && previous !== null) {
        ranges.push(rangeStart === previous ? String(rangeStart) : `${rangeStart}-${previous}`);
    }

    return ranges.join(',');
}

async function writeQpdfArgsFile(args: string[]) {
    const tempDir = await mkdtemp(join(tmpdir(), 'qpdfArgs-'));
    const argsPath = join(tempDir, 'args.txt');
    await writeFile(argsPath, args.map(arg => arg.replace(/\r?\n/g, ' ')).join('\n'));
    return {
        argsPath,
        cleanup: async () => {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        },
    };
}

export async function runQpdfCommand(args: string[], options: Parameters<typeof runNativeToolCommand>[2]) {
    const argsFile = await writeQpdfArgsFile(args);
    try {
        await runNativeToolCommand(getQpdfBinary(), [`@${argsFile.argsPath}`], options);
    } finally {
        await argsFile.cleanup();
    }
}

export async function getPdfPageCount(pdfPath: string) {
    const result = await runNativeToolCommand(getQpdfBinary(), [
        '--show-npages',
        pdfPath,
    ], {
        timeoutMs: QPDF_TIMEOUT_MS,
        commandLabel: 'qpdf(page-count)',
    });
    const pageCount = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error('Failed to read PDF page count');
    }

    return pageCount;
}

async function replaceQpdfOutput(tempPath: string, targetPath: string) {
    await replaceTempOutput(tempPath, targetPath);
}

async function cleanupQpdfTemp(tempPath: string) {
    await cleanupTempOutput(tempPath, log, 'qpdf temp file');
}

async function cleanupEmptyTarget(targetPath: string) {
    try {
        const outputStat = await stat(targetPath);
        if (outputStat.size === 0) {
            await unlink(targetPath);
        }
    } catch (cleanupError) {
        if (isErrnoException(cleanupError) && cleanupError.code === 'ENOENT') {
            return;
        }

        log.debug(`Failed to cleanup empty output file "${targetPath}": ${
            getErrorMessage(cleanupError)
        }`);
    }
}

export async function assertNonEmptyPdfOutput(outputPath: string, operationLabel: string) {
    let outputStat: Awaited<ReturnType<typeof stat>>;
    try {
        outputStat = await stat(outputPath);
    } catch (error) {
        throw new Error(`${operationLabel} failed: qpdf did not produce an output file`, {cause: error});
    }

    if (outputStat.size === 0) {
        throw new Error(`${operationLabel} failed: qpdf produced an empty PDF`);
    }
}

export async function extractPages(
    srcPath: string,
    destPath: string,
    pages: number[],
) {
    const tempPath = makeTempPdfOutputPath(destPath);
    try {
        await runQpdfCommand([
            srcPath,
            '--pages',
            srcPath,
            formatPageList(pages),
            '--',
            tempPath,
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(extract-pages)',
        });
        await assertNonEmptyPdfOutput(tempPath, 'Extracting pages');
        await replaceQpdfOutput(tempPath, destPath);
    } catch (err) {
        await cleanupQpdfTemp(tempPath);
        await cleanupEmptyTarget(destPath);
        throw err;
    }
}

export async function deletePages(
    workingCopyPath: string,
    pagesToDelete: number[],
    expectedTotalPages?: number,
    senderWebContentsId?: number,
) {
    if (!await ensureWorkingCopyDirectory(workingCopyPath, senderWebContentsId)) {
        throw new Error('Working copy path is not managed');
    }
    const totalPages = await getPdfPageCount(workingCopyPath);
    if (expectedTotalPages !== undefined && expectedTotalPages !== totalPages) {
        throw new Error('Renderer page count is stale');
    }

    const kept = buildComplementRanges(pagesToDelete, totalPages);
    if (kept.length === 0) {
        throw new Error('Cannot delete all pages from the document');
    }

    const tempPath = makeTempPdfOutputPath(workingCopyPath);

    try {
        await runQpdfCommand([
            workingCopyPath,
            '--pages',
            workingCopyPath,
            formatPageList(kept),
            '--',
            tempPath,
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(delete-pages)',
        });
        await assertNonEmptyPdfOutput(tempPath, 'Deleting pages');
        await replaceQpdfOutput(tempPath, workingCopyPath);
    } catch (err) {
        await cleanupQpdfTemp(tempPath);
        throw err;
    }

    return { pageCount: kept.length };
}

export async function reorderPages(
    workingCopyPath: string,
    newOrder: number[],
    senderWebContentsId?: number,
) {
    if (!await ensureWorkingCopyDirectory(workingCopyPath, senderWebContentsId)) {
        throw new Error('Working copy path is not managed');
    }
    const tempPath = makeTempPdfOutputPath(workingCopyPath);

    try {
        await runQpdfCommand([
            workingCopyPath,
            '--pages',
            workingCopyPath,
            formatPageList(newOrder),
            '--',
            tempPath,
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(reorder-pages)',
        });
        await assertNonEmptyPdfOutput(tempPath, 'Reordering pages');
        await replaceQpdfOutput(tempPath, workingCopyPath);
    } catch (err) {
        await cleanupQpdfTemp(tempPath);
        throw err;
    }

    return { pageCount: newOrder.length };
}

export type TRotationAngle = 90 | 180 | 270;

export async function rotatePages(
    workingCopyPath: string,
    pages: number[],
    angle: TRotationAngle,
    senderWebContentsId?: number,
) {
    if (!await ensureWorkingCopyDirectory(workingCopyPath, senderWebContentsId)) {
        throw new Error('Working copy path is not managed');
    }
    const tempPath = makeTempPdfOutputPath(workingCopyPath);

    try {
        await runQpdfCommand([
            workingCopyPath,
            `--rotate=+${angle}:${formatPageList(pages)}`,
            tempPath,
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(rotate-pages)',
        });
        await assertNonEmptyPdfOutput(tempPath, 'Rotating pages');
        await replaceQpdfOutput(tempPath, workingCopyPath);
    } catch (err) {
        await cleanupQpdfTemp(tempPath);
        throw err;
    }
}
