import {
    stat,
    unlink,
} from 'fs/promises';
import { runNativeToolCommand } from '@electron/native-tools/exec';
import { getNativeToolPaths } from '@electron/native-tools/paths';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';
import {
    cleanupTempOutput,
    makeTempPdfOutputPath,
    replaceTempOutput,
} from '@electron/features/page-ops/main/tempOutput';
import { ensureWorkingCopyDirectory } from '@electron/ipc/workingCopyCreation';

const log = createLogger('page-ops-qpdf');
const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
// qpdf exits with 3 when it completed the write but found warnings in the input.
const QPDF_OUTPUT_SUCCESS_EXIT_CODES = [
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
    return pages.join(',');
}

async function replaceQpdfOutput(tempPath: string, targetPath: string) {
    await replaceTempOutput(tempPath, targetPath, { replaceExistingTargetOnFailure: true });
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
        const err = cleanupError as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
            return;
        }

        log.debug(`Failed to cleanup empty output file "${targetPath}": ${
            getErrorMessage(cleanupError)
        }`);
    }
}

async function assertNonEmptyPdfOutput(outputPath: string, operationLabel: string) {
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
    const qpdf = getQpdfBinary();
    const tempPath = makeTempPdfOutputPath(destPath);
    try {
        const args = [
            srcPath,
            '--pages',
            srcPath,
            formatPageList(pages),
            '--',
            tempPath,
        ];
        await runNativeToolCommand(qpdf, args, {
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
    totalPages: number,
) {
    const kept = buildComplementRanges(pagesToDelete, totalPages);
    if (kept.length === 0) {
        throw new Error('Cannot delete all pages from the document');
    }

    const qpdf = getQpdfBinary();
    if (!await ensureWorkingCopyDirectory(workingCopyPath)) {
        throw new Error('Working copy path is not managed');
    }
    const tempPath = makeTempPdfOutputPath(workingCopyPath);

    try {
        const args = [
            workingCopyPath,
            '--pages',
            workingCopyPath,
            formatPageList(kept),
            '--',
            tempPath,
        ];
        await runNativeToolCommand(qpdf, args, {
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
) {
    const qpdf = getQpdfBinary();
    if (!await ensureWorkingCopyDirectory(workingCopyPath)) {
        throw new Error('Working copy path is not managed');
    }
    const tempPath = makeTempPdfOutputPath(workingCopyPath);

    try {
        const args = [
            workingCopyPath,
            '--pages',
            workingCopyPath,
            formatPageList(newOrder),
            '--',
            tempPath,
        ];
        await runNativeToolCommand(qpdf, args, {
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
) {
    const qpdf = getQpdfBinary();
    if (!await ensureWorkingCopyDirectory(workingCopyPath)) {
        throw new Error('Working copy path is not managed');
    }
    const tempPath = makeTempPdfOutputPath(workingCopyPath);

    try {
        const args = [
            workingCopyPath,
            `--rotate=+${angle}:${formatPageList(pages)}`,
            tempPath,
        ];
        await runNativeToolCommand(qpdf, args, {
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
