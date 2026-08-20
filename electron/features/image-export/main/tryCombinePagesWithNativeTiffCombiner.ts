import { existsSync } from 'fs';
import {
    mkdtemp,
    rm,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { createNativeFallbackTestError } from '@electron/native-tools/createNativeFallbackTestError';
import { runNativeCommand } from '@electron/native-tools/runNativeCommand';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { resolveNativePdfImageCombinePath } from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import { abortErrorFromSignal } from '@electron/utils/abort';

const logger = createLogger('nativeTiffCombine');
const NATIVE_TIFF_COMBINE_TEST_ENABLE_ENV = 'EVB_TIFF_COMBINE_NATIVE_ENABLE';
const NATIVE_TIFF_COMBINE_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_TIFF_COMBINE_NATIVE_TIMEOUT_MS ?? `${10 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000) {
        return 10 * 60 * 1000;
    }
    return parsed;
})();

function isNativeTiffCombineDisabled() {
    return process.env.EVB_TIFF_COMBINE_NATIVE_DISABLE === '1'
        || process.env.EVB_PDF_IMAGE_COMBINE_DISABLE === '1'
        || (process.env.VITEST === 'true' && process.env[NATIVE_TIFF_COMBINE_TEST_ENABLE_ENV] !== '1');
}

export async function tryCombinePagesWithNativeTiffCombiner(pagePaths: string[], outputPath: string, signal?: AbortSignal) {
    if (isNativeTiffCombineDisabled() || pagePaths.length === 0) {
        return false;
    }

    const binaryPath = resolveNativePdfImageCombinePath();
    if (!binaryPath) {
        const testFailure = createNativeFallbackTestError(
            NATIVE_TIFF_COMBINE_TEST_ENABLE_ENV,
            'Native TIFF combine',
            'native binary path could not be resolved',
        );
        if (testFailure) {
            throw testFailure;
        }
        return false;
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'tiff-combine-native-'));
    const inputsPath = join(tempDir, 'inputs.txt');
    const tempOutputPath = makeSiblingTempPath(outputPath);
    let replacedOutput = false;

    try {
        if (signal?.aborted) throw abortErrorFromSignal(signal);
        await writeFile(inputsPath, createNativeInputsFileContents(pagePaths), 'utf8');
        const ok = await runNativeTiffCombine(binaryPath, tempOutputPath, inputsPath, signal);
        if (!ok || !existsSync(tempOutputPath)) {
            const testFailure = createNativeFallbackTestError(
                NATIVE_TIFF_COMBINE_TEST_ENABLE_ENV,
                'Native TIFF combine',
                !ok
                    ? 'native command reported failure'
                    : `native output was not created at "${tempOutputPath}"`,
            );
            if (testFailure) {
                throw testFailure;
            }
            return false;
        }

        if (signal?.aborted) throw abortErrorFromSignal(signal);
        await atomicReplace(tempOutputPath, outputPath);
        replacedOutput = true;
        return true;
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
        if (!replacedOutput) {
            await rm(tempOutputPath, { force: true }).catch(() => undefined);
        }
    }
}

function canRepresentPathInNativeInputsFile(inputPath: string) {
    return inputPath.length > 0
        && inputPath.trim() === inputPath
        && !/[\r\n]/u.test(inputPath);
}

function createNativeInputsFileContents(pagePaths: string[]) {
    if (!pagePaths.every(canRepresentPathInNativeInputsFile)) {
        throw new Error('Native TIFF combine input paths must not contain leading/trailing whitespace or line breaks');
    }
    return `${pagePaths.join('\n')}\n`;
}

async function runNativeTiffCombine(binaryPath: string, outputPath: string, inputsPath: string, signal?: AbortSignal) {
    try {
        await runNativeCommand(binaryPath, [
            '--output',
            outputPath,
            '--format',
            'tiff',
            '--inputs-file',
            inputsPath,
        ], {
            timeoutMs: NATIVE_TIFF_COMBINE_TIMEOUT_MS,
            commandLabel: 'evb-pdf-image-combine(tiff)',
            maxStdoutBytes: 1024,
            maxStderrBytes: 8_192,
            defaultCwdToCommandDir: true,
            prependCommandDirToPath: true,
            ...(signal ? { signal } : {}),
        });
        return true;
    } catch (error) {
        if (signal?.aborted) throw abortErrorFromSignal(signal);
        const testFailure = createNativeFallbackTestError(
            NATIVE_TIFF_COMBINE_TEST_ENABLE_ENV,
            'Native TIFF combine',
            'native command failed',
            error,
        );
        if (testFailure) {
            throw testFailure;
        }
        logger.debug(`Native TIFF combine failed: ${getErrorMessage(error)}`);
        return false;
    }
}
