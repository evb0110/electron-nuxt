import { randomUUID } from 'node:crypto';
import { existsSync } from 'fs';
import {
    rename,
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
import type { TOpenPath } from '@electron/ipc/openPathCapabilities';

const log = createLogger('page-ops-insert-service');
const QPDF_TIMEOUT_MS = 2 * 60 * 1000;

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
    const dir = join(workingCopyPath, '..');
    const id = `tmp-${randomUUID()}`;
    const tempPath = join(dir, `${id}.pdf`);

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
            commandLabel: 'qpdf(insert-pages)',
        });
        await rename(tempPath, workingCopyPath);
    } catch (err) {
        try {
            if (existsSync(tempPath)) {
                await unlink(tempPath);
            }
        } catch (cleanupError) {
            log.debug(`Failed to cleanup temporary insert output "${tempPath}": ${
                getErrorMessage(cleanupError)
            }`);
        }
        throw err;
    } finally {
        await cleanup();
    }
}
