import { randomUUID } from 'node:crypto';
import { existsSync } from 'fs';
import {
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    extname,
    join,
} from 'path';
import {
    createPdfFromInputPaths,
    isPdfOrImagePath,
} from '@electron/image/pdfConversion';
import { runNativeToolCommand } from '@electron/native-tools/exec';
import { getNativeToolPaths } from '@electron/native-tools/paths';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';
import { ensureWorkingCopyDirectory } from '@electron/ipc/workingCopyCreation';
import {
    cleanupTempOutput,
    makeTempPdfOutputPath,
    replaceTempOutput,
} from '@electron/features/page-ops/main/tempOutput';
import type { TOpenPath } from '@electron/ipc/openPathCapabilities';

const log = createLogger('page-ops-insert-service');
const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
const QPDF_OUTPUT_SUCCESS_EXIT_CODES = [
    0,
    3,
];

async function assertNonEmptyPdfOutput(outputPath: string) {
    let outputStat: Awaited<ReturnType<typeof stat>>;
    try {
        outputStat = await stat(outputPath);
    } catch (error) {
        throw new Error('Inserting pages failed: qpdf did not produce an output file', {cause: error});
    }

    if (outputStat.size === 0) {
        throw new Error('Inserting pages failed: qpdf produced an empty PDF');
    }
}

async function prepareInsertionSourcePdf(
    workingCopyPath: string,
    sourcePaths: TOpenPath[],
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

    await ensureWorkingCopyDirectory(workingCopyPath);
    const mergedPdf = await createPdfFromInputPaths(sourcePaths);
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
    totalPages: number,
    sourcePaths: TOpenPath[],
    afterPage: number,
) {
    await ensureWorkingCopyDirectory(workingCopyPath);
    const qpdf = getNativeToolPaths().qpdf;
    const tempPath = makeTempPdfOutputPath(workingCopyPath);

    const {
        sourcePdfPath,
        cleanup,
    } = await prepareInsertionSourcePdf(workingCopyPath, sourcePaths);

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
        await runNativeToolCommand(qpdf, args, {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(insert-pages)',
        });
        await assertNonEmptyPdfOutput(tempPath);
        await replaceTempOutput(tempPath, workingCopyPath);
    } catch (err) {
        await cleanupTempOutput(tempPath, log, 'temporary insert output');
        throw err;
    } finally {
        await cleanup();
    }
}
