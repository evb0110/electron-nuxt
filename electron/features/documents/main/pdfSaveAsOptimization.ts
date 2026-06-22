import {
    rm,
    stat,
} from 'fs/promises';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import type { IPdfSaveAsOptions } from '@contracts/electronApiDocuments';
import { isRecord } from '@contracts/runtimeGuards';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import { getNativeToolPaths } from '@electron/native-tools/getNativeToolPaths';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import {
    analyzePdfConformanceFile,
    validatePdfFile,
} from '@electron/features/documents/main/pdfConformance';

const logger = createLogger('documents-pdfSaveAsOptimization');

const QPDF_SAVE_AS_OPTIMIZE_TIMEOUT_MS = parseIntegerEnv(
    'EVB_QPDF_SAVE_AS_OPTIMIZE_TIMEOUT_MS',
    10 * 60 * 1000,
    1_000,
);

export function normalizePdfSaveAsOptions(value: unknown): IPdfSaveAsOptions | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    return value.optimizeLossless === true
        ? { optimizeLossless: true }
        : undefined;
}

async function shouldSkipOptimization(filePath: string) {
    const profile = await analyzePdfConformanceFile(filePath);
    if (profile.isSigned) {
        return 'signed PDF';
    }
    if (profile.isEncrypted) {
        return 'encrypted PDF';
    }
    if (profile.pdfaLevel) {
        return `${profile.pdfaLevel} PDF`;
    }
    if (profile.hasXfa) {
        return 'XFA PDF';
    }

    return null;
}

async function rewritePdfLosslessly(inputPath: string, outputPath: string) {
    await runNativeToolCommand(getNativeToolPaths().qpdf, [
        '--stream-data=preserve',
        '--object-streams=generate',
        inputPath,
        outputPath,
    ], {
        allowedExitCodes: [
            0,
            3,
        ],
        commandLabel: 'qpdf(save-as-optimize)',
        timeoutMs: QPDF_SAVE_AS_OPTIMIZE_TIMEOUT_MS,
    });
}

export async function optimizePdfForSaveAs(
    tempPath: string,
    options?: IPdfSaveAsOptions,
): Promise<IPdfValidationResult | null> {
    if (options?.optimizeLossless !== true) {
        return null;
    }

    try {
        const skipReason = await shouldSkipOptimization(tempPath);
        if (skipReason) {
            logger.debug(`Skipping Save As PDF optimization for "${tempPath}": ${skipReason}`);
            return null;
        }
    } catch (error) {
        logger.warn(`Skipping Save As PDF optimization for "${tempPath}": ${getErrorMessage(error)}`);
        return null;
    }

    const optimizedPath = makeSiblingTempPath(tempPath);
    let consumedOptimizedPath = false;
    try {
        await rewritePdfLosslessly(tempPath, optimizedPath);
        const [
            originalStats,
            optimizedStats,
        ] = await Promise.all([
            stat(tempPath),
            stat(optimizedPath),
        ]);
        if (optimizedStats.size >= originalStats.size) {
            logger.debug(
                `Discarding Save As PDF optimization for "${tempPath}": optimized file is not smaller`,
            );
            return null;
        }

        const validation = await validatePdfFile(optimizedPath);
        if (!validation.isValid) {
            logger.warn(
                `Discarding Save As PDF optimization for "${tempPath}": optimized file failed validation`,
            );
            return null;
        }

        await atomicReplace(optimizedPath, tempPath);
        consumedOptimizedPath = true;
        logger.debug(
            `Applied Save As PDF optimization for "${tempPath}": ${
                originalStats.size
            } -> ${optimizedStats.size} bytes`,
        );
        return validation;
    } catch (error) {
        logger.warn(`Save As PDF optimization failed for "${tempPath}": ${getErrorMessage(error)}`);
        return null;
    } finally {
        if (!consumedOptimizedPath) {
            await rm(optimizedPath, { force: true }).catch(() => undefined);
        }
    }
}
