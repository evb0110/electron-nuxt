import { randomUUID } from 'node:crypto';
import { existsSync } from 'fs';
import {
    unlink,
    writeFile,
} from 'fs/promises';
import {
    extname,
    join,
} from 'path';
import {
    type ICreatePdfFromInputPathsProgress,
    createPdfFromInputPaths,
    isPdfOrImagePath,
} from '@electron/image/pdfConversion';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';
import { ensureWorkingCopyDirectory } from '@electron/ipc/workingCopyCreation';
import {
    cleanupTempOutput,
    makeTempPdfOutputPath,
    replaceTempOutput,
} from '@electron/features/page-ops/main/tempOutput';
import {
    assertNonEmptyPdfOutput,
    getPdfPageCount,
    QPDF_OUTPUT_SUCCESS_EXIT_CODES,
    QPDF_TIMEOUT_MS,
    runQpdfCommand,
} from '@electron/features/page-ops/main/qpdf';
import type { TOpenPath } from '@electron/ipc/openPathCapabilities';

const log = createLogger('page-ops-insert-service');

async function prepareInsertionSourcePdf(
    workingCopyPath: string,
    sourcePaths: TOpenPath[],
    senderWebContentsId?: number,
    onProgress?: (progress: ICreatePdfFromInputPathsProgress) => void,
) {
    if (sourcePaths.length === 0) {
        throw new Error('At least one source file is required');
    }

    for (const sourcePath of sourcePaths) {
        if (!existsSync(sourcePath)) {
            throw new Error(`Source file not found: ${sourcePath}`);
        }
        if (!isPdfOrImagePath(sourcePath)) {
            throw new Error(`Unsupported source file type: ${sourcePath}`);
        }
    }

    if (sourcePaths.length === 1 && extname(sourcePaths[0]!).toLowerCase() === '.pdf') {
        return {
            sourcePdfPath: sourcePaths[0]!,
            cleanup: async () => {},
        };
    }

    if (!await ensureWorkingCopyDirectory(workingCopyPath, senderWebContentsId)) {
        throw new Error('Working copy path is not managed');
    }
    const mergedPdf = await createPdfFromInputPaths(sourcePaths, onProgress ? {onProgress} : undefined);
    const tempSourcePdfPath = join(
        workingCopyPath,
        '..',
        `insert-source-${randomUUID()}.pdf`,
    );
    await writeFile(tempSourcePdfPath, mergedPdf);

    return {
        sourcePdfPath: tempSourcePdfPath,
        cleanup: async () => {
            try {
                if (existsSync(tempSourcePdfPath)) {
                    await unlink(tempSourcePdfPath);
                }
            } catch (cleanupError) {
                log.debug(`Failed to cleanup insertion source PDF "${tempSourcePdfPath}": ${
                    getErrorMessage(cleanupError)
                }`);
            }
        },
    };
}

export async function insertPagesFromSourcePaths(
    workingCopyPath: string,
    expectedTotalPages: number,
    sourcePaths: TOpenPath[],
    afterPage: number,
    senderWebContentsId?: number,
    onProgress?: (progress: ICreatePdfFromInputPathsProgress) => void,
) {
    if (!await ensureWorkingCopyDirectory(workingCopyPath, senderWebContentsId)) {
        throw new Error('Working copy path is not managed');
    }
    const totalPages = await getPdfPageCount(workingCopyPath);
    if (expectedTotalPages !== totalPages) {
        throw new Error('Renderer page count is stale');
    }
    if (afterPage > totalPages) {
        throw new Error('Invalid afterPage');
    }
    const tempPath = makeTempPdfOutputPath(workingCopyPath);

    const {
        sourcePdfPath,
        cleanup,
    } = await prepareInsertionSourcePdf(workingCopyPath, sourcePaths, senderWebContentsId, onProgress);

    try {
        const pagesArgs: string[] = [];

        if (afterPage >= 1) {
            pagesArgs.push(workingCopyPath, `1-${afterPage}`);
        }

        pagesArgs.push(sourcePdfPath, '1-z');

        if (afterPage < totalPages) {
            pagesArgs.push(workingCopyPath, `${afterPage + 1}-${totalPages}`);
        }

        const args = [
            workingCopyPath,
            '--pages',
            ...pagesArgs,
            '--',
            tempPath,
        ];
        await runQpdfCommand(args, {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(insert-pages)',
        });
        await assertNonEmptyPdfOutput(tempPath, 'Inserting pages');
        await replaceTempOutput(tempPath, workingCopyPath);
    } catch (err) {
        await cleanupTempOutput(tempPath, log, 'temporary insert output');
        throw err;
    } finally {
        await cleanup();
    }
}
