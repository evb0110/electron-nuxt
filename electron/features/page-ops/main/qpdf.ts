import {
    copyFile,
    rm,
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { isErrnoException } from '@contracts/runtimeGuards';
import {
    cleanupTempOutput,
    makeTempPdfOutputPath,
    replaceTempOutput,
} from '@electron/features/page-ops/main/tempOutput';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import { ensureWorkingCopyMaterialized } from '@electron/file-access/workingCopyMaterialization';
import { getWorkingCopyBackingEntry } from '@electron/file-access/workingCopyStore';
import { createManagedScratchTempDir } from '@electron/utils/managedScratchTemp';
import {
    getPdfPageCount,
    QPDF_OUTPUT_SUCCESS_EXIT_CODES,
    QPDF_TIMEOUT_MS,
} from '@electron/pdf/pdfPageCount';

const log = createLogger('page-ops-qpdf');
export {
    getPdfPageCount,
    QPDF_OUTPUT_SUCCESS_EXIT_CODES,
    QPDF_TIMEOUT_MS,
};

export interface IQpdfOperationOptions {
    signal?: AbortSignal;
    cancelGroup?: string;
    senderWebContentsId?: number;
}

interface IQpdfWorkingCopyMaterialization {
    path: string;
    senderWebContentsId?: number;
    signal?: AbortSignal;
}
type TRunQpdfCommandOptions = Parameters<typeof runNativeToolCommand>[2]
    & {workingCopyMaterialization?: IQpdfWorkingCopyMaterialization};

export async function materializePageOperationWorkingCopy(
    workingCopyPath: string,
    senderWebContentsId?: number,
    signal?: AbortSignal,
) {
    if (!getWorkingCopyBackingEntry(workingCopyPath, senderWebContentsId)) {
        if (!await ensureWorkingCopyDirectory(workingCopyPath, senderWebContentsId)) {
            throw new Error('Working copy path is not managed');
        }
        return workingCopyPath;
    }
    const result = await ensureWorkingCopyMaterialized(workingCopyPath, {
        reason: 'page-operation',
        ...(senderWebContentsId === undefined ? {} : {ownerWebContentsId: senderWebContentsId}),
        ...(signal ? {signal} : {}),
    });
    return result.physicalWorkingCopyPath;
}

function getQpdfBinary() {
    return getPdfNativeToolPaths().qpdf;
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

function formatComplementPageList(pagesToRemove: number[], totalPages: number) {
    const removePages = new Set(pagesToRemove);
    const ranges: string[] = [];
    let keptCount = 0;
    let rangeStart: number | null = null;
    let previous: number | null = null;

    for (let page = 1; page <= totalPages; page += 1) {
        if (removePages.has(page)) {
            if (rangeStart !== null && previous !== null) {
                ranges.push(rangeStart === previous ? String(rangeStart) : `${rangeStart}-${previous}`);
                rangeStart = null;
                previous = null;
            }
            continue;
        }

        keptCount += 1;
        rangeStart ??= page;
        previous = page;
    }

    if (rangeStart !== null && previous !== null) {
        ranges.push(rangeStart === previous ? String(rangeStart) : `${rangeStart}-${previous}`);
    }

    return {
        pageList: ranges.join(','),
        keptCount,
    };
}

async function writeQpdfArgsFile(args: string[]) {
    const tempDir = await createManagedScratchTempDir('qpdfArgs-');
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

export async function runQpdfCommand(
    args: string[],
    options: TRunQpdfCommandOptions,
) {
    const {
        workingCopyMaterialization,
        ...nativeOptions
    } = options;
    if (workingCopyMaterialization) {
        await materializePageOperationWorkingCopy(
            workingCopyMaterialization.path,
            workingCopyMaterialization.senderWebContentsId,
            workingCopyMaterialization.signal,
        );
    }
    const argsFile = await writeQpdfArgsFile(args);
    try {
        await runNativeToolCommand(getQpdfBinary(), [`@${argsFile.argsPath}`], nativeOptions);
    } finally {
        await argsFile.cleanup();
    }
}

/** Strict reopen/xref gate: warning-corrupt output is not promotable. */
export async function verifyPdfStructureStrict(pdfPath: string, options: IQpdfOperationOptions = {}) {
    await runNativeToolCommand(getQpdfBinary(), [
        '--check',
        pdfPath,
    ], {
        timeoutMs: QPDF_TIMEOUT_MS,
        allowedExitCodes: [0],
        commandLabel: 'qpdf(strict-structure-check)',
        ...(options.signal ? {signal: options.signal} : {}),
        ...(options.cancelGroup ? {cancelGroup: options.cancelGroup} : {}),
    });
}

async function replaceQpdfOutput(tempPath: string, targetPath: string) {
    await replaceTempOutput(tempPath, targetPath);
}

async function cleanupQpdfTemp(tempPath: string) {
    await cleanupTempOutput(tempPath, log, 'qpdf temp file');
}

async function createManagedQpdfOutputPath() {
    const tempDir = await createManagedScratchTempDir('qpdfOutput-');
    return {
        outputPath: join(tempDir, 'output.pdf'),
        tempDir,
    };
}

async function cleanupManagedQpdfOutput(tempDir: string) {
    try {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
    } catch (cleanupError) {
        log.debug(`Failed to cleanup qpdf output directory "${tempDir}": ${
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
    options: IQpdfOperationOptions = {},
) {
    const physicalReadPath = getWorkingCopyBackingEntry(srcPath, options.senderWebContentsId)
        ? await materializePageOperationWorkingCopy(
            srcPath,
            options.senderWebContentsId,
            options.signal,
        )
        : srcPath;
    const qpdfOutput = await createManagedQpdfOutputPath();
    const finalTempPath = makeTempPdfOutputPath(destPath);
    try {
        await runQpdfCommand([
            physicalReadPath,
            '--pages',
            physicalReadPath,
            formatPageList(pages),
            '--',
            qpdfOutput.outputPath,
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(extract-pages)',
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.cancelGroup ? { cancelGroup: options.cancelGroup } : {}),
        });
        await assertNonEmptyPdfOutput(qpdfOutput.outputPath, 'Extracting pages');
        await copyFile(qpdfOutput.outputPath, finalTempPath);
        await assertNonEmptyPdfOutput(finalTempPath, 'Extracting pages');
        await replaceQpdfOutput(finalTempPath, destPath);
    } catch (err) {
        await cleanupQpdfTemp(finalTempPath);
        await cleanupEmptyTarget(destPath);
        throw err;
    } finally {
        await cleanupManagedQpdfOutput(qpdfOutput.tempDir);
    }
}

export async function deletePages(
    workingCopyPath: string,
    pagesToDelete: number[],
    expectedTotalPages?: number,
    senderWebContentsId?: number,
    options: IQpdfOperationOptions = {},
) {
    const materializedPath = await materializePageOperationWorkingCopy(
        workingCopyPath,
        senderWebContentsId,
        options.signal,
    );
    const totalPages = await getPdfPageCount(materializedPath, options);
    if (expectedTotalPages !== undefined && expectedTotalPages !== totalPages) {
        throw new Error('Renderer page count is stale');
    }

    const {
        pageList,
        keptCount,
    } = formatComplementPageList(pagesToDelete, totalPages);
    if (keptCount === 0) {
        throw new Error('Cannot delete all pages from the document');
    }

    const tempPath = makeTempPdfOutputPath(materializedPath);

    try {
        await runQpdfCommand([
            materializedPath,
            '--pages',
            materializedPath,
            pageList,
            '--',
            tempPath,
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(delete-pages)',
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.cancelGroup ? { cancelGroup: options.cancelGroup } : {}),
        });
        await assertNonEmptyPdfOutput(tempPath, 'Deleting pages');
        await replaceQpdfOutput(tempPath, materializedPath);
    } catch (err) {
        await cleanupQpdfTemp(tempPath);
        throw err;
    }

    return { pageCount: keptCount };
}

export async function reorderPages(
    workingCopyPath: string,
    newOrder: number[],
    senderWebContentsId?: number,
    options: IQpdfOperationOptions = {},
) {
    const materializedPath = await materializePageOperationWorkingCopy(
        workingCopyPath,
        senderWebContentsId,
        options.signal,
    );
    const tempPath = makeTempPdfOutputPath(materializedPath);

    try {
        await runQpdfCommand([
            materializedPath,
            '--pages',
            materializedPath,
            formatPageList(newOrder),
            '--',
            tempPath,
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(reorder-pages)',
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.cancelGroup ? { cancelGroup: options.cancelGroup } : {}),
        });
        await assertNonEmptyPdfOutput(tempPath, 'Reordering pages');
        await replaceQpdfOutput(tempPath, materializedPath);
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
    options: IQpdfOperationOptions = {},
) {
    const materializedPath = await materializePageOperationWorkingCopy(
        workingCopyPath,
        senderWebContentsId,
        options.signal,
    );
    const tempPath = makeTempPdfOutputPath(materializedPath);

    try {
        await runQpdfCommand([
            materializedPath,
            `--rotate=+${angle}:${formatPageList(pages)}`,
            tempPath,
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(rotate-pages)',
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.cancelGroup ? { cancelGroup: options.cancelGroup } : {}),
        });
        await assertNonEmptyPdfOutput(tempPath, 'Rotating pages');
        await replaceQpdfOutput(tempPath, materializedPath);
    } catch (err) {
        await cleanupQpdfTemp(tempPath);
        throw err;
    }
}
