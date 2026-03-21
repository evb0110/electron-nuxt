import { spawn } from 'child_process';
import { ensureTessdataLanguages } from '@electron/ocr/language-models';
import { getOcrPaths } from '@electron/ocr/paths';
import { resolveTesseractLanguageConfig } from '@electron/ocr/tesseract-language-config';

type TTesseractSpawnOptions = {threads?: number;};

interface IOcrResult {
    success: boolean;
    text: string;
    error?: string;
}

const TESSERACT_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_TESSERACT_TIMEOUT_MS ?? `${2 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 5_000) {
        return 2 * 60 * 1000;
    }
    return parsed;
})();
const TESSERACT_KILL_GRACE_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_TESSERACT_KILL_GRACE_MS ?? '2000', 10);
    if (!Number.isFinite(parsed) || parsed < 250) {
        return 2_000;
    }
    return parsed;
})();
const TESSERACT_MAX_STDOUT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_TESSERACT_MAX_STDOUT_BYTES ?? '262144', 10);
    if (!Number.isFinite(parsed) || parsed < 1_024) {
        return 262_144;
    }
    return parsed;
})();
const TESSERACT_MAX_STDERR_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_TESSERACT_MAX_STDERR_BYTES ?? '262144', 10);
    if (!Number.isFinite(parsed) || parsed < 1_024) {
        return 262_144;
    }
    return parsed;
})();

function appendWithCap(current: string, chunk: Buffer, maxBytes: number) {
    if (maxBytes <= 0) {
        return {
            value: '',
            truncated: true,
        };
    }

    const nextValue = current + chunk.toString();
    if (Buffer.byteLength(nextValue, 'utf8') <= maxBytes) {
        return {
            value: nextValue,
            truncated: false,
        };
    }

    const keepBytes = Math.max(1, Math.floor(maxBytes * 0.9));
    let tail = nextValue;
    while (Buffer.byteLength(tail, 'utf8') > keepBytes && tail.length > 1) {
        tail = tail.slice(Math.floor(tail.length * 0.1));
    }

    return {
        value: tail,
        truncated: true,
    };
}

function buildTesseractEnv(
    tessdata: string,
    options?: TTesseractSpawnOptions,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        TESSDATA_PREFIX: tessdata,
    };

    const threads = options?.threads;
    if (typeof threads === 'number' && Number.isFinite(threads) && threads > 0) {
        // If Tesseract is built with OpenMP, these variables control parallelism.
        // If not, they are ignored safely.
        env.OMP_THREAD_LIMIT = String(Math.floor(threads));
        env.OMP_NUM_THREADS = String(Math.floor(threads));
    }

    return env;
}

export async function runOcr(
    imageBuffer: Buffer,
    languages: string[],
    options?: TTesseractSpawnOptions,
): Promise<IOcrResult> {
    const languageConfig = resolveTesseractLanguageConfig(languages);
    await ensureTessdataLanguages(languageConfig.orderedLanguages);

    const {
        binary,
        tessdata,
    } = await getOcrPaths();

    const args = [
        'stdin',
        'stdout',
        '-l',
        languageConfig.orderedLanguages.join('+'),
        '--tessdata-dir',
        tessdata,
        ...languageConfig.extraConfigArgs,
    ];

    return new Promise((resolve) => {
        const proc = spawn(binary, args, {env: buildTesseractEnv(tessdata, options)});

        let stdout = '';
        let stderr = '';
        let stderrTruncated = false;
        let settled = false;
        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | null = null;
        let killHandle: NodeJS.Timeout | null = null;
        let forceFinalizeHandle: NodeJS.Timeout | null = null;

        const finalize = (result: IOcrResult) => {
            if (settled) {
                return;
            }

            settled = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (killHandle) {
                clearTimeout(killHandle);
                killHandle = null;
            }
            if (forceFinalizeHandle) {
                clearTimeout(forceFinalizeHandle);
                forceFinalizeHandle = null;
            }
            resolve(result);
        };

        const killProcessImmediately = () => {
            try {
                proc.kill('SIGKILL');
                return;
            } catch {
                // Fall through to SIGTERM if SIGKILL is unavailable.
            }

            try {
                proc.kill('SIGTERM');
            } catch {
                // Process may already be gone.
            }
        };

        timeoutHandle = setTimeout(() => {
            timedOut = true;
            try {
                proc.kill('SIGTERM');
            } catch {
                // Process may already be gone.
            }

            killHandle = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                } catch {
                    // Process may already be gone.
                }
            }, TESSERACT_KILL_GRACE_MS);
            killHandle.unref?.();

            forceFinalizeHandle = setTimeout(() => {
                finalize({
                    success: false,
                    text: '',
                    error: `Tesseract timed out after ${TESSERACT_TIMEOUT_MS}ms`,
                });
            }, TESSERACT_KILL_GRACE_MS + 1_000);
            forceFinalizeHandle.unref?.();
        }, TESSERACT_TIMEOUT_MS);
        timeoutHandle.unref?.();

        proc.stdout?.on('data', (data: Buffer) => {
            const appended = appendWithCap(stdout, data, TESSERACT_MAX_STDOUT_BYTES);
            stdout = appended.value;
        });

        proc.stderr?.on('data', (data: Buffer) => {
            const appended = appendWithCap(stderr, data, TESSERACT_MAX_STDERR_BYTES);
            stderr = appended.value;
            stderrTruncated = stderrTruncated || appended.truncated;
        });

        proc.on('close', (code) => {
            if (timedOut) {
                finalize({
                    success: false,
                    text: '',
                    error: `Tesseract timed out after ${TESSERACT_TIMEOUT_MS}ms`,
                });
                return;
            }

            if (code === 0) {
                finalize({
                    success: true,
                    text: stdout.trim(),
                });
            } else {
                const stderrSummary = stderrTruncated
                    ? `[stderr truncated to ${TESSERACT_MAX_STDERR_BYTES} bytes]\n${stderr}`
                    : stderr;
                finalize({
                    success: false,
                    text: '',
                    error: stderrSummary || `Tesseract exited with code ${code}`,
                });
            }
        });

        proc.on('error', (err) => {
            finalize({
                success: false,
                text: '',
                error: err.message,
            });
        });

        proc.stdin?.on('error', (stdinError) => {
            killProcessImmediately();
            finalize({
                success: false,
                text: '',
                error: stdinError.message,
            });
        });

        if (!proc.stdin) {
            killProcessImmediately();
            finalize({
                success: false,
                text: '',
                error: 'Tesseract stdin is unavailable',
            });
            return;
        }

        proc.stdin.end(imageBuffer, (stdinError?: Error | null) => {
            if (stdinError) {
                killProcessImmediately();
                finalize({
                    success: false,
                    text: '',
                    error: stdinError.message,
                });
            }
        });
    });
}
