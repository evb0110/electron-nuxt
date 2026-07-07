import {
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import type { ICropMargins } from '@contracts/shared';
import { createNativeFallbackTestError } from '@electron/native-tools/createNativeFallbackTestError';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getErrorMessage } from '@electron/utils/error';
import { createLogger } from '@electron/utils/createLogger';
import {
    cleanupTempOutput,
    makeTempPdfOutputPath,
    replaceTempOutput,
} from '@electron/features/page-ops/main/tempOutput';
import { createManagedScratchTempDir } from '@electron/utils/managedScratchTemp';
import {
    isNativePageOpsDisabled,
    NATIVE_PAGE_OPS_TEST_ENABLE_ENV,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/main/nativePageOpsPath';

type TCropOperation = 'crop' | 'remove-crop';

const log = createLogger('native-page-ops-crop');
const NATIVE_PAGE_OPS_TIMEOUT_MS = 2 * 60 * 1000;

function createPageFileContents(pages: number[]) {
    return `${pages.map(page => String(page)).join('\n')}\n`;
}

function createNativeCropArgs(
    operation: TCropOperation,
    workingCopyPath: string,
    outputPath: string,
    pagesFilePath: string,
    margins?: ICropMargins,
) {
    const args = [
        operation,
        '--input',
        workingCopyPath,
        '--output',
        outputPath,
        '--pages-file',
        pagesFilePath,
    ];

    if (operation === 'crop' && margins) {
        args.push(
            '--top',
            String(margins.top),
            '--bottom',
            String(margins.bottom),
            '--left',
            String(margins.left),
            '--right',
            String(margins.right),
        );
    }

    return args;
}

async function assertNativeOutputReady(outputPath: string) {
    const outputStat = await stat(outputPath);
    if (outputStat.size === 0) {
        throw new Error('Native page crop produced an empty PDF');
    }
}

async function tryRunNativeCropOperation(
    operation: TCropOperation,
    workingCopyPath: string,
    pages: number[],
    margins?: ICropMargins,
    signal?: AbortSignal,
) {
    if (isNativePageOpsDisabled()) {
        return false;
    }

    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        const testFailure = createNativeFallbackTestError(
            NATIVE_PAGE_OPS_TEST_ENABLE_ENV,
            'Native page ops',
            `no binary path resolved for ${operation}`,
        );
        if (testFailure) {
            throw testFailure;
        }
        return false;
    }

    const tempPath = makeTempPdfOutputPath(workingCopyPath);
    const tempDir = await createManagedScratchTempDir('pdf-page-ops-');
    const pagesFilePath = join(tempDir, 'pages.txt');

    try {
        await writeFile(pagesFilePath, createPageFileContents(pages));
        await runNativeToolCommand(binaryPath, createNativeCropArgs(
            operation,
            workingCopyPath,
            tempPath,
            pagesFilePath,
            margins,
        ), {
            timeoutMs: NATIVE_PAGE_OPS_TIMEOUT_MS,
            commandLabel: `evb-pdf-page-ops(${operation})`,
            ...(signal ? { signal } : {}),
        });
        await assertNativeOutputReady(tempPath);
        await replaceTempOutput(tempPath, workingCopyPath);
        return true;
    } catch (error) {
        await cleanupTempOutput(tempPath, log, 'native page crop temp file');
        const testFailure = createNativeFallbackTestError(
            NATIVE_PAGE_OPS_TEST_ENABLE_ENV,
            'Native page ops',
            `${operation} failed`,
            error,
        );
        if (testFailure) {
            throw testFailure;
        }
        log.debug(`Native page crop failed, falling back to pdf-lib: ${getErrorMessage(error)}`);
        return false;
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}

export function tryCropPagesWithNativePageOps(
    workingCopyPath: string,
    pages: number[],
    margins: ICropMargins,
    signal?: AbortSignal,
) {
    return tryRunNativeCropOperation('crop', workingCopyPath, pages, margins, signal);
}

export function tryRemoveCropWithNativePageOps(
    workingCopyPath: string,
    pages: number[],
    signal?: AbortSignal,
) {
    return tryRunNativeCropOperation('remove-crop', workingCopyPath, pages, undefined, signal);
}
