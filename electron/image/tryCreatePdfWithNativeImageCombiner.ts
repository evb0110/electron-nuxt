import { spawn } from 'child_process';
import { existsSync } from 'fs';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import {
    dirname,
    extname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { resolveOcrResourcesBase } from '@electron/ocr/resolveOcrResourcesBase';
import { resolvePlatformArchTag } from '@electron/utils/platformArch';
import { getErrorMessage } from '@electron/utils/error';
import { createLogger } from '@electron/utils/createLogger';

interface INativePdfImageCombineProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface INativePdfImageCombineOptions {onProgress?: (progress: INativePdfImageCombineProgress) => void;}

type TNativeProgressPayload = INativePdfImageCombineProgress & {type: 'progress';};

const logger = createLogger('nativePdfImageCombine');
const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = __dirname.includes('app.asar');
const SUPPORTED_NATIVE_BITMAP_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
]);
const SUPPORTED_NATIVE_NETPBM_EXTENSIONS = new Set([
    '.pgm',
    '.ppm',
]);
const NATIVE_PDF_IMAGE_COMBINE_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_IMAGE_COMBINE_TIMEOUT_MS ?? `${5 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000) {
        return 5 * 60 * 1000;
    }
    return parsed;
})();

function getBinaryName() {
    return process.platform === 'win32'
        ? 'evb-pdf-image-combine.exe'
        : 'evb-pdf-image-combine';
}

function isNativeImageCombineDisabled() {
    return process.env.EVB_PDF_IMAGE_COMBINE_DISABLE === '1'
        || (process.env.VITEST === 'true' && process.env.EVB_PDF_IMAGE_COMBINE_ENABLE !== '1');
}

export function resolveNativePdfImageCombinePath() {
    const overridePath = process.env.EVB_PDF_IMAGE_COMBINE_PATH?.trim();
    if (overridePath && existsSync(overridePath)) {
        return overridePath;
    }

    const binaryName = getBinaryName();
    const platformArch = resolvePlatformArchTag();
    const resourcesBase = resolveOcrResourcesBase(__dirname, isPackaged);
    const candidates = [
        join(resourcesBase, 'pdf-image-combine', platformArch, 'bin', binaryName),
        join(process.cwd(), 'native', 'pdf-image-combine', 'target', 'release', binaryName),
    ];

    return candidates.find(candidate => existsSync(candidate)) ?? null;
}

function canUseNativePdfImageCombine(inputPaths: string[], supportedExtensions: Set<string>) {
    return !isNativeImageCombineDisabled()
        && inputPaths.length > 0
        && inputPaths.every(path => supportedExtensions.has(extname(path).toLowerCase()));
}

function parseProgressPayload(value: unknown): TNativeProgressPayload | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const payload = value as Record<string, unknown>;
    if (payload.type !== 'progress') {
        return null;
    }
    if (
        typeof payload.processed !== 'number'
        || typeof payload.total !== 'number'
        || typeof payload.percent !== 'number'
        || typeof payload.elapsedMs !== 'number'
    ) {
        return null;
    }

    return {
        type: 'progress',
        processed: payload.processed,
        total: payload.total,
        percent: payload.percent,
        elapsedMs: payload.elapsedMs,
        estimatedRemainingMs: typeof payload.estimatedRemainingMs === 'number'
            ? payload.estimatedRemainingMs
            : null,
    };
}

export async function tryCreatePdfWithNativeImageCombiner(
    inputPaths: string[],
    options?: INativePdfImageCombineOptions,
): Promise<Uint8Array | null> {
    if (!canUseNativePdfImageCombine(inputPaths, SUPPORTED_NATIVE_BITMAP_EXTENSIONS)) {
        return null;
    }

    return createPdfWithNativeImageCombiner(inputPaths, options);
}

export async function tryBuildOptimizedPdfWithNativeImageCombiner(
    imagePaths: string[],
    dpi: number,
    onPageProcessed?: (pageNum: number, totalPages: number) => void,
): Promise<Uint8Array | null> {
    if (!Number.isFinite(dpi) || dpi <= 0 || !canUseNativePdfImageCombine(imagePaths, SUPPORTED_NATIVE_NETPBM_EXTENSIONS)) {
        return null;
    }

    return createPdfWithNativeImageCombiner(imagePaths, onPageProcessed
        ? {onProgress: progress => onPageProcessed(progress.processed, progress.total)}
        : undefined, [
        '--dpi',
        String(Math.round(dpi)),
    ]);
}

async function createPdfWithNativeImageCombiner(
    inputPaths: string[],
    options?: INativePdfImageCombineOptions,
    extraArgs: string[] = [],
) {
    const binaryPath = resolveNativePdfImageCombinePath();
    if (!binaryPath) {
        return null;
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'pdf-image-combine-'));
    const outputPath = join(tempDir, `${randomUUID()}.pdf`);
    const inputsPath = join(tempDir, 'inputs.txt');

    try {
        await writeFile(inputsPath, `${inputPaths.join('\n')}\n`, 'utf8');
        const ok = await runNativePdfImageCombine(binaryPath, outputPath, [], options, [
            ...extraArgs,
            '--inputs-file',
            inputsPath,
        ]);
        if (!ok) {
            return null;
        }
        return new Uint8Array(await readFile(outputPath));
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}

function runNativePdfImageCombine(
    binaryPath: string,
    outputPath: string,
    inputPaths: string[],
    options?: INativePdfImageCombineOptions,
    extraArgs: string[] = [],
) {
    return new Promise<boolean>((resolve) => {
        const args = [
            '--output',
            outputPath,
            '--json-progress',
            ...extraArgs,
        ];
        if (inputPaths.length > 0) {
            args.push('--', ...inputPaths);
        }

        const proc = spawn(binaryPath, args, {
            shell: false,
            windowsHide: true,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });

        let settled = false;
        let stdoutBuffer = '';
        let stderr = '';
        let timedOut = false;

        const finish = (ok: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutHandle);
            resolve(ok);
        };

        const handleProgressLine = (line: string) => {
            if (!line.trim() || !options?.onProgress) {
                return;
            }
            try {
                const payload = parseProgressPayload(JSON.parse(line));
                if (payload) {
                    options.onProgress({
                        processed: payload.processed,
                        total: payload.total,
                        percent: payload.percent,
                        elapsedMs: payload.elapsedMs,
                        estimatedRemainingMs: payload.estimatedRemainingMs,
                    });
                }
            } catch {
                return;
            }
        };

        const timeoutHandle = setTimeout(() => {
            timedOut = true;
            proc.kill('SIGKILL');
        }, NATIVE_PDF_IMAGE_COMBINE_TIMEOUT_MS);
        timeoutHandle.unref?.();

        proc.stdout?.on('data', (data: Buffer) => {
            stdoutBuffer += data.toString('utf8');
            let lineBreak = stdoutBuffer.indexOf('\n');
            while (lineBreak >= 0) {
                const line = stdoutBuffer.slice(0, lineBreak);
                stdoutBuffer = stdoutBuffer.slice(lineBreak + 1);
                handleProgressLine(line);
                lineBreak = stdoutBuffer.indexOf('\n');
            }
        });

        proc.stderr?.on('data', (data: Buffer) => {
            stderr = `${stderr}${data.toString('utf8')}`.slice(-8_192);
        });

        proc.on('error', (error) => {
            logger.warn(`Native image PDF combine failed to start: ${getErrorMessage(error)}`);
            finish(false);
        });

        proc.on('close', (code) => {
            if (stdoutBuffer) {
                handleProgressLine(stdoutBuffer);
                stdoutBuffer = '';
            }
            if (timedOut) {
                logger.warn(`Native image PDF combine timed out after ${NATIVE_PDF_IMAGE_COMBINE_TIMEOUT_MS}ms`);
                finish(false);
                return;
            }
            if (code !== 0) {
                const detail = stderr.trim();
                logger.debug(`Native image PDF combine exited with code ${code}${detail ? `: ${detail}` : ''}`);
                finish(false);
                return;
            }
            finish(true);
        });
    });
}
