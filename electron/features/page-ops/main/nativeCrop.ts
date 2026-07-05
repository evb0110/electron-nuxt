import {
    mkdtemp,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import type { ICropMargins } from '@contracts/shared';
import { createNativeFallbackTestError } from '@electron/native-tools/createNativeFallbackTestError';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import { getErrorMessage } from '@electron/utils/error';
import { createLogger } from '@electron/utils/createLogger';
import {
    cleanupTempOutput,
    makeTempPdfOutputPath,
    replaceTempOutput,
} from '@electron/features/page-ops/main/tempOutput';

type TCropOperation = 'crop' | 'remove-crop';

const log = createLogger('native-page-ops-crop');
const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = __dirname.includes('app.asar');
const NATIVE_PAGE_OPS_TIMEOUT_MS = 2 * 60 * 1000;
const NATIVE_PAGE_OPS_TEST_ENABLE_ENV = 'EVB_PDF_PAGE_OPS_ENABLE';

function getBinaryName() {
    return process.platform === 'win32'
        ? 'evb-pdf-page-ops.exe'
        : 'evb-pdf-page-ops';
}

export function isNativePageOpsDisabled() {
    return process.env.EVB_PDF_PAGE_OPS_DISABLE === '1'
        || (process.env.VITEST === 'true' && process.env[NATIVE_PAGE_OPS_TEST_ENABLE_ENV] !== '1');
}

export function resolveNativePageOpsPath() {
    return resolveNativeToolPath({
        binaryName: getBinaryName(),
        crateName: 'pdf-page-ops',
        currentDir: __dirname,
        envOverridePath: process.env.EVB_PDF_PAGE_OPS_PATH,
        isPackaged,
    });
}

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
    const tempDir = await mkdtemp(join(tmpdir(), 'pdf-page-ops-'));
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
