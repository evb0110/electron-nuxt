import { join } from 'path';
import { randomUUID } from 'node:crypto';
import {
    rename,
    unlink,
} from 'fs/promises';
import { existsSync } from 'fs';
import { runNativeToolCommand } from '@electron/native-tools/exec';
import { getNativeToolPaths } from '@electron/native-tools/paths';
import { createLogger } from '@electron/utils/logger';

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
    await rename(tempPath, targetPath);
}

async function cleanupTemp(tempPath: string) {
    try {
        if (existsSync(tempPath)) {
            await unlink(tempPath);
        }
    } catch (cleanupError) {
        log.debug(`Failed to cleanup qpdf temp file "${tempPath}": ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`);
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
        await atomicReplace(tempPath, destPath);
    } catch (err) {
        await cleanupTemp(tempPath);
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
        await atomicReplace(tempPath, workingCopyPath);
    } catch (err) {
        await cleanupTemp(tempPath);
        throw err;
    }
}
