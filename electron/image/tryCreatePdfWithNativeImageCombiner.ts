import { spawn } from 'child_process';
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
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import { getErrorMessage } from '@electron/utils/error';
import { createLogger } from '@electron/utils/createLogger';

interface INativePdfImageCombineProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface INativePdfImageCombineOptions {
    maxPages?: number;
    onProgress?: (progress: INativePdfImageCombineProgress) => void;
}

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
const NATIVE_PDF_IMAGE_COMBINE_MAX_STDOUT_BUFFER_BYTES = 64 * 1024;
const PDF_HEADER_SCAN_BYTES = 1024;
const PDF_EOF_SCAN_BYTES = 1024 * 1024;

function getBinaryName() {
    return process.platform === 'win32'
        ? 'evb-pdf-image-combine.exe'
        : 'evb-pdf-image-combine';
}

export function isNativePdfImageCombineDisabled() {
    return process.env.EVB_PDF_IMAGE_COMBINE_DISABLE === '1'
        || (process.env.VITEST === 'true' && process.env.EVB_PDF_IMAGE_COMBINE_ENABLE !== '1');
}

export function resolveNativePdfImageCombinePath() {
    return resolveNativeToolPath({
        binaryName: getBinaryName(),
        crateName: 'pdf-image-combine',
        currentDir: __dirname,
        envOverridePath: process.env.EVB_PDF_IMAGE_COMBINE_PATH,
        isPackaged,
    });
}

function canUseNativePdfImageCombine(inputPaths: string[], supportedExtensions: Set<string>) {
    return !isNativePdfImageCombineDisabled()
        && inputPaths.length > 0
        && inputPaths.every(path => supportedExtensions.has(extname(path).toLowerCase()))
        && inputPaths.every(canRepresentPathInNativeInputsFile);
}

export function isNativePdfImageCombineBitmapPath(inputPath: string) {
    return SUPPORTED_NATIVE_BITMAP_EXTENSIONS.has(extname(inputPath).toLowerCase());
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

function canRepresentPathInNativeInputsFile(inputPath: string) {
    return inputPath.length > 0
        && inputPath.trim() === inputPath
        && !/[\r\n]/u.test(inputPath);
}

function createNativeInputsFileContents(inputPaths: string[]) {
    if (!inputPaths.every(canRepresentPathInNativeInputsFile)) {
        throw new Error('Native image combine input paths must not contain leading/trailing whitespace or line breaks');
    }
    return `${inputPaths.join('\n')}\n`;
}

function includesAsciiToken(data: Uint8Array, token: string, start: number, end: number) {
    const tokenBytes = Buffer.from(token, 'ascii');
    const lastStart = end - tokenBytes.byteLength;
    for (let offset = start; offset <= lastStart; offset += 1) {
        let matches = true;
        for (let index = 0; index < tokenBytes.byteLength; index += 1) {
            if (data[offset + index] !== tokenBytes[index]) {
                matches = false;
                break;
            }
        }
        if (matches) {
            return true;
        }
    }
    return false;
}

function isStructurallyPlausiblePdf(data: Uint8Array) {
    if (data.byteLength === 0) {
        return false;
    }
    const headerEnd = Math.min(data.byteLength, PDF_HEADER_SCAN_BYTES);
    const eofStart = Math.max(0, data.byteLength - PDF_EOF_SCAN_BYTES);
    return includesAsciiToken(data, '%PDF-', 0, headerEnd)
        && includesAsciiToken(data, '%%EOF', eofStart, data.byteLength);
}

async function readValidatedNativePdfOutput(outputPath: string) {
    try {
        const bytes = new Uint8Array(await readFile(outputPath));
        if (isStructurallyPlausiblePdf(bytes)) {
            return bytes;
        }
        logger.warn(`Native image PDF combine produced invalid PDF output at "${outputPath}"`);
    } catch (error) {
        logger.warn(`Native image PDF combine output is unavailable at "${outputPath}": ${getErrorMessage(error)}`);
    }

    await rm(outputPath, { force: true }).catch(() => undefined);
    return null;
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

export async function tryWritePdfWithNativeImageCombiner(
    inputPaths: string[],
    outputPath: string,
    options?: INativePdfImageCombineOptions,
): Promise<boolean> {
    if (!canUseNativePdfImageCombine(inputPaths, SUPPORTED_NATIVE_BITMAP_EXTENSIONS)) {
        return false;
    }

    return writePdfWithNativeImageCombiner(inputPaths, outputPath, options);
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
        await writeFile(inputsPath, createNativeInputsFileContents(inputPaths), 'utf8');
        const ok = await runNativePdfImageCombine(binaryPath, outputPath, [], options, [
            ...extraArgs,
            '--inputs-file',
            inputsPath,
        ]);
        if (!ok) {
            return null;
        }
        return await readValidatedNativePdfOutput(outputPath);
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}

async function writePdfWithNativeImageCombiner(
    inputPaths: string[],
    outputPath: string,
    options?: INativePdfImageCombineOptions,
) {
    const binaryPath = resolveNativePdfImageCombinePath();
    if (!binaryPath) {
        return false;
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'pdf-image-combine-'));
    const inputsPath = join(tempDir, 'inputs.txt');

    try {
        await writeFile(inputsPath, createNativeInputsFileContents(inputPaths), 'utf8');
        const ok = await runNativePdfImageCombine(binaryPath, outputPath, [], options, [
            '--inputs-file',
            inputsPath,
        ]);
        if (!ok) {
            return false;
        }
        return await readValidatedNativePdfOutput(outputPath) !== null;
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
        const maxPages = normalizeMaxPagesForEnv(options?.maxPages);

        const proc = spawn(binaryPath, args, {
            ...(maxPages ? {env: {
                ...process.env,
                EVB_PDF_COMBINE_MAX_PAGES: maxPages,
            }} : {}),
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
            if (Buffer.byteLength(stdoutBuffer, 'utf8') > NATIVE_PDF_IMAGE_COMBINE_MAX_STDOUT_BUFFER_BYTES) {
                logger.warn(`Native image PDF combine stdout line exceeded ${NATIVE_PDF_IMAGE_COMBINE_MAX_STDOUT_BUFFER_BYTES} bytes`);
                proc.kill('SIGKILL');
                finish(false);
                return;
            }
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

function normalizeMaxPagesForEnv(value: number | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
        return null;
    }
    return String(Math.trunc(value));
}
