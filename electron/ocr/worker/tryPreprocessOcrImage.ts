import { stat } from 'fs/promises';
import { runOcrCommand } from '@electron/ocr/worker/runOcrCommand';
import type { TWorkerLog } from '@electron/ocr/worker/types';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';

const OCR_PREPROCESS_TIMEOUT_MS = parseIntegerEnv('EVB_OCR_PREPROCESS_TIMEOUT_MS', 30_000, 1_000);
const OCR_UNPAPER_PROBE_TIMEOUT_MS = parseIntegerEnv('EVB_OCR_UNPAPER_PROBE_TIMEOUT_MS', 3_000, 250);
const unpaperProbeByBinary = new Map<string, Promise<boolean>>();

async function isNonEmptyFile(path: string) {
    try {
        return (await stat(path)).size > 0;
    } catch {
        return false;
    }
}

async function probeUnpaperBinary(
    unpaperBinary: string,
    log: TWorkerLog,
    signal: AbortSignal,
) {
    const cachedProbe = unpaperProbeByBinary.get(unpaperBinary);
    if (cachedProbe) {
        return cachedProbe;
    }

    const probe = runOcrCommand(unpaperBinary, ['--version'], {
        timeoutMs: OCR_UNPAPER_PROBE_TIMEOUT_MS,
        commandLabel: 'unpaper(version-probe)',
        signal,
        log,
    }).then(
        () => true,
        (error) => {
            if (signal.aborted) {
                unpaperProbeByBinary.delete(unpaperBinary);
                throw error;
            }
            log('warn', `OCR preprocessing disabled because bundled unpaper is not runnable: ${getErrorMessage(error)}`);
            return false;
        },
    );

    unpaperProbeByBinary.set(unpaperBinary, probe);
    return probe;
}

export async function tryPreprocessOcrImage(
    unpaperBinary: string | undefined,
    inputPath: string,
    outputPath: string,
    log: TWorkerLog,
    signal: AbortSignal,
) {
    if (!unpaperBinary) {
        log('warn', 'OCR preprocessing requested, but unpaper is not bundled for this platform');
        return inputPath;
    }

    if (!await probeUnpaperBinary(unpaperBinary, log, signal)) {
        return inputPath;
    }

    try {
        await runOcrCommand(unpaperBinary, [
            '--layout',
            'single',
            '--deskew',
            '--cleanup',
            '--no-mask-center',
            '--despeckle',
            inputPath,
            outputPath,
        ], {
            timeoutMs: OCR_PREPROCESS_TIMEOUT_MS,
            commandLabel: 'unpaper(ocr-preprocess)',
            signal,
            log,
        });
        if (!await isNonEmptyFile(outputPath)) {
            log('warn', 'OCR preprocessing did not produce a usable image; using raw page render');
            return inputPath;
        }
        return outputPath;
    } catch (error) {
        if (signal.aborted) {
            throw error;
        }
        log('warn', `OCR preprocessing failed; using raw page render: ${getErrorMessage(error)}`);
        return inputPath;
    }
}
