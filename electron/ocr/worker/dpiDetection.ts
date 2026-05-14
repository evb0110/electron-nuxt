import type { TWorkerLog } from '@electron/ocr/worker/types';
import {
    runOcrCommand,
    type IRunCommandOptions,
} from '@electron/ocr/worker/runCommand';
import { clamp } from 'es-toolkit/math';
import { getErrorMessage } from '@electron/utils/error';

const PDFIMAGES_TIMEOUT_MS = 30 * 1000;

export async function detectSourceDpi(
    pdfPath: string,
    pdfimagesBinary: string | undefined,
    log: TWorkerLog,
    commandEnv?: NodeJS.ProcessEnv,
): Promise<number | null> {
    if (!pdfimagesBinary) {
        return null;
    }

    try {
        const commandOptions: IRunCommandOptions = {
            commandLabel: 'pdfimages(-list)',
            timeoutMs: PDFIMAGES_TIMEOUT_MS,
            log,
        };
        if (commandEnv !== undefined) {
            commandOptions.env = commandEnv;
        }

        const result = await runOcrCommand(pdfimagesBinary, [
            '-list',
            pdfPath,
        ], commandOptions);
        const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (lines.length <= 1) {
            return null;
        }

        let best = 0;
        for (const line of lines.slice(1)) {
            const parts = line.split(/\s+/);
            if (parts.length < 14) {
                continue;
            }
            const xPpi = parseInt(parts[12] ?? '', 10);
            const yPpi = parseInt(parts[13] ?? '', 10);
            const dpi = Math.max(
                Number.isFinite(xPpi) ? xPpi : 0,
                Number.isFinite(yPpi) ? yPpi : 0,
            );
            if (dpi > best) {
                best = dpi;
            }
        }

        if (best > 0) {
            return best;
        }
    } catch (err) {
        log('debug', `pdfimages detection failed: ${getErrorMessage(err)}`);
    }

    return null;
}

export function clampDpi(value: number) {
    if (!Number.isFinite(value)) {
        return 300;
    }
    return clamp(Math.round(value), 72, 1200);
}
