import { join } from 'path';
import { randomUUID } from 'node:crypto';
import {
    rename,
    stat,
    unlink,
} from 'fs/promises';
import { existsSync } from 'fs';
import { runNativeToolCommand } from '@electron/native-tools/exec';
import { getNativeToolPaths } from '@electron/native-tools/paths';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';

const log = createLogger('page-ops-qpdf');
const QPDF_TIMEOUT_MS = 2 * 60 * 1000;

function getQpdfBinary() {
    return getNativeToolPaths().qpdf;
}

function makeTempPath(workingCopyPath: string) {
    const dir = join(workingCopyPath, '..');
    const id = `tmp-${randomUUID()}`;
    return join(dir, `${id}.pdf`);
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

async function atomicReplace(tempPath: string, targetPath: string) {
    try {
        await rename(tempPath, targetPath);
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'EEXIST' && err.code !== 'EPERM') {
            throw error;
        }

        await unlink(targetPath);
        await rename(tempPath, targetPath);
    }
}

async function cleanupTemp(tempPath: string) {
    try {
        if (existsSync(tempPath)) {
            await unlink(tempPath);
        }
    } catch (cleanupError) {
        log.debug(`Failed to cleanup qpdf temp file "${tempPath}": ${
            getErrorMessage(cleanupError)
        }`);
    }
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
    const tempPath = makeTempPath(destPath);
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
            commandLabel: 'qpdf(extract-pages)',
        });
        await assertNonEmptyPdfOutput(tempPath, 'Extracting pages');
        await atomicReplace(tempPath, destPath);
    } catch (err) {
        await cleanupTemp(tempPath);
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
    const tempPath = makeTempPath(workingCopyPath);

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
            commandLabel: 'qpdf(delete-pages)',
        });
        await assertNonEmptyPdfOutput(tempPath, 'Deleting pages');
        await atomicReplace(tempPath, workingCopyPath);
    } catch (err) {
        await cleanupTemp(tempPath);
        throw err;
    }

    return { pageCount: kept.length };
}

export async function reorderPages(
    workingCopyPath: string,
    newOrder: number[],
) {
    const qpdf = getQpdfBinary();
    const tempPath = makeTempPath(workingCopyPath);

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
            commandLabel: 'qpdf(reorder-pages)',
        });
        await assertNonEmptyPdfOutput(tempPath, 'Reordering pages');
        await atomicReplace(tempPath, workingCopyPath);
    } catch (err) {
        await cleanupTemp(tempPath);
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
    const tempPath = makeTempPath(workingCopyPath);

    try {
        const args = [
            workingCopyPath,
            `--rotate=+${angle}:${formatPageList(pages)}`,
            tempPath,
        ];
        await runNativeToolCommand(qpdf, args, {
            timeoutMs: QPDF_TIMEOUT_MS,
            commandLabel: 'qpdf(rotate-pages)',
        });
        await assertNonEmptyPdfOutput(tempPath, 'Rotating pages');
        await atomicReplace(tempPath, workingCopyPath);
    } catch (err) {
        await cleanupTemp(tempPath);
        throw err;
    }
}
