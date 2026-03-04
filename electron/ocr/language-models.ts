import { homedir } from 'os';
import { randomUUID } from 'node:crypto';
import {
    copyFileSync,
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
} from 'fs';
import {
    copyFile,
    mkdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {
    dirname,
    join,
} from 'path';
import { Readable } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import { delay } from 'es-toolkit/promise';
import { createLogger } from '@electron/utils/logger';
import { forEachConcurrent } from '@electron/utils/concurrency';
import { AVAILABLE_OCR_LANGUAGE_CODES } from '@electron/ocr/available-languages';

const log = createLogger('ocr-language-models');
const DOWNLOAD_BASE_URL = 'https://github.com/tesseract-ocr/tessdata_best/raw/main';
const DOWNLOAD_TIMEOUT_MS = 90_000;
const DOWNLOAD_RETRIES = 3;
const RETRY_DELAY_MS = 1_500;
const PRECHECK_TIMEOUT_MS = 4_000;
const NON_RETRYABLE_HTTP_STATUSES = new Set([
    400,
    401,
    403,
    404,
    410,
]);
const NETWORK_UNREACHABLE_CODES = new Set([
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ENETRESET',
    'ECONNREFUSED',
    'ECONNRESET',
    'ECONNABORTED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'ERR_NETWORK_CHANGED',
]);

const inFlightDownloads = new Map<string, Promise<void>>();
const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = __dirname.includes('app.asar');
const OCR_MODEL_DOWNLOAD_CONCURRENCY = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_MODEL_DOWNLOAD_CONCURRENCY ?? '3', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 3;
    }
    return Math.min(parsed, 8);
})();
const OCR_MAX_UNIQUE_MODEL_CODES = (() => {
    const parsed = Number.parseInt(
        process.env.EVB_OCR_MAX_UNIQUE_LANGUAGES_PER_JOB ?? `${AVAILABLE_OCR_LANGUAGE_CODES.size}`,
        10,
    );
    if (!Number.isFinite(parsed) || parsed < 1) {
        return AVAILABLE_OCR_LANGUAGE_CODES.size;
    }
    return Math.min(parsed, AVAILABLE_OCR_LANGUAGE_CODES.size);
})();

function getElectronUserDataPath(): string {
    const appName = 'EVB Viewer';
    if (process.platform === 'win32') {
        return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), appName);
    }
    if (process.platform === 'darwin') {
        return join(homedir(), 'Library', 'Application Support', appName);
    }
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), appName);
}

function normalizeLanguageCodes(languageCodes: string[]): string[] {
    const deduped = new Set<string>();
    for (const languageCode of languageCodes) {
        const normalized = languageCode.trim().toLowerCase();
        if (normalized.length > 0) {
            deduped.add(normalized);
        }
    }
    return Array.from(deduped);
}

class LanguageModelDownloadError extends Error {
    readonly retryable: boolean;
    readonly code: string;

    constructor(
        message: string,
        options: {
            retryable: boolean;
            code: string;
        },
    ) {
        super(message);
        this.name = 'LanguageModelDownloadError';
        this.retryable = options.retryable;
        this.code = options.code;
    }
}

function getErrorCode(error: unknown): string | null {
    const visited = new Set<unknown>();
    let current: unknown = error;

    while (current && typeof current === 'object' && !visited.has(current)) {
        visited.add(current);
        const code = (current as { code?: unknown }).code;
        if (typeof code === 'string' && code.length > 0) {
            return code;
        }
        current = (current as { cause?: unknown }).cause;
    }

    return null;
}

function isAbortError(error: unknown) {
    if (!error || typeof error !== 'object') {
        return false;
    }

    return (error as { name?: string }).name === 'AbortError';
}

function createHttpDownloadError(languageCode: string, statusCode: number) {
    if (statusCode === 404) {
        return new LanguageModelDownloadError(
            `OCR language model "${languageCode}" is unavailable (HTTP 404). Verify language configuration and try again.`,
            {
                retryable: false,
                code: `HTTP_${statusCode}`,
            },
        );
    }

    if (NON_RETRYABLE_HTTP_STATUSES.has(statusCode)) {
        return new LanguageModelDownloadError(
            `OCR language model "${languageCode}" download rejected by server (HTTP ${statusCode}).`,
            {
                retryable: false,
                code: `HTTP_${statusCode}`,
            },
        );
    }

    return new LanguageModelDownloadError(
        `OCR language model "${languageCode}" download failed with HTTP ${statusCode}.`,
        {
            retryable: true,
            code: `HTTP_${statusCode}`,
        },
    );
}

function classifyDownloadError(languageCode: string, error: unknown, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
    if (error instanceof LanguageModelDownloadError) {
        return error;
    }

    if (isAbortError(error)) {
        return new LanguageModelDownloadError(
            `OCR language model "${languageCode}" download timed out after ${timeoutMs}ms.`,
            {
                retryable: true,
                code: 'DOWNLOAD_TIMEOUT',
            },
        );
    }

    const errorCode = getErrorCode(error);
    if (errorCode && NETWORK_UNREACHABLE_CODES.has(errorCode)) {
        return new LanguageModelDownloadError(
            `Network is offline or unreachable (${errorCode}) while downloading OCR model "${languageCode}". Check connection and retry OCR.`,
            {
                retryable: false,
                code: 'NETWORK_UNREACHABLE',
            },
        );
    }

    const message = error instanceof Error ? error.message : String(error);
    const normalizedMessage = message.toLowerCase();
    if (
        normalizedMessage.includes('network is unreachable')
        || normalizedMessage.includes('failed to resolve')
        || normalizedMessage.includes('getaddrinfo')
        || normalizedMessage.includes('not known')
    ) {
        return new LanguageModelDownloadError(
            `Network is offline or DNS is unreachable while downloading OCR model "${languageCode}".`,
            {
                retryable: false,
                code: 'NETWORK_UNREACHABLE',
            },
        );
    }

    return new LanguageModelDownloadError(
        `OCR model "${languageCode}" download failed: ${message}`,
        {
            retryable: true,
            code: 'DOWNLOAD_FAILED',
        },
    );
}

function getBundledTessdataDir() {
    if (isPackaged) {
        return join(process.resourcesPath, 'tesseract', 'tessdata');
    }

    return join(__dirname, '..', 'resources', 'tesseract', 'tessdata');
}

export function getRuntimeTessdataDir() {
    if (isPackaged) {
        return join(getElectronUserDataPath(), 'tessdata');
    }

    return getBundledTessdataDir();
}

function getModelPath(baseDir: string, languageCode: string) {
    return join(baseDir, `${languageCode}.traineddata`);
}

function seedBundledModelsSync(runtimeDir: string) {
    if (!isPackaged) {
        return;
    }

    const bundledDir = getBundledTessdataDir();
    if (!existsSync(bundledDir)) {
        return;
    }

    mkdirSync(runtimeDir, { recursive: true });

    const bundledFiles = readdirSync(bundledDir)
        .filter(fileName => fileName.endsWith('.traineddata'));

    for (const fileName of bundledFiles) {
        const sourcePath = join(bundledDir, fileName);
        const destinationPath = join(runtimeDir, fileName);
        if (existsSync(destinationPath)) {
            continue;
        }
        copyFileSync(sourcePath, destinationPath);
    }
}

export function ensureRuntimeTessdataSeededSync() {
    const runtimeDir = getRuntimeTessdataDir();
    seedBundledModelsSync(runtimeDir);
}

async function seedBundledModels(runtimeDir: string) {
    if (!isPackaged) {
        return;
    }

    const bundledDir = getBundledTessdataDir();
    if (!existsSync(bundledDir)) {
        return;
    }

    await mkdir(runtimeDir, { recursive: true });

    const bundledFiles = readdirSync(bundledDir)
        .filter(fileName => fileName.endsWith('.traineddata'));

    for (const fileName of bundledFiles) {
        const sourcePath = join(bundledDir, fileName);
        const destinationPath = join(runtimeDir, fileName);
        if (existsSync(destinationPath)) {
            continue;
        }
        await copyFile(sourcePath, destinationPath);
    }
}

async function precheckLanguageDownload(languageCode: string, languageUrl: string) {
    try {
        const response = await fetch(languageUrl, {
            method: 'HEAD',
            signal: AbortSignal.timeout(PRECHECK_TIMEOUT_MS),
        });

        if (!response.ok) {
            throw createHttpDownloadError(languageCode, response.status);
        }
    } catch (error) {
        const classified = classifyDownloadError(languageCode, error, PRECHECK_TIMEOUT_MS);
        if (!classified.retryable || classified.code === 'NETWORK_UNREACHABLE') {
            throw classified;
        }

        log.warn(
            `Skipping OCR model precheck strictness for ${languageCode}: ${classified.message}. Continuing with download attempts.`,
        );
    }
}

async function downloadLanguageModel(languageCode: string, runtimeDir: string) {
    const modelPath = getModelPath(runtimeDir, languageCode);
    if (existsSync(modelPath)) {
        return;
    }

    const languageUrl = `${DOWNLOAD_BASE_URL}/${encodeURIComponent(languageCode)}.traineddata`;
    const tempPath = `${modelPath}.download-${randomUUID()}`;
    await precheckLanguageDownload(languageCode, languageUrl);

    for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
        try {
            log.info(`Downloading OCR model ${languageCode} (attempt ${attempt}/${DOWNLOAD_RETRIES})`);
            const response = await fetch(languageUrl, {
                method: 'GET',
                signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            });

            if (!response.ok) {
                throw createHttpDownloadError(languageCode, response.status);
            }

            await mkdir(runtimeDir, { recursive: true });
            if (response.body && typeof Readable.fromWeb === 'function') {
                const readable = Readable.fromWeb(response.body as NodeReadableStream);
                const writable = createWriteStream(tempPath, { flags: 'wx' });
                await pipeline(readable, writable);
            } else {
                // Fallback for environments where Readable.fromWeb is unavailable.
                const arrayBuffer = await response.arrayBuffer();
                await writeFile(tempPath, Buffer.from(arrayBuffer));
            }

            const downloadedSize = (await stat(tempPath)).size;
            if (downloadedSize < 1024) {
                throw new Error('Downloaded model is unexpectedly small');
            }
            await rename(tempPath, modelPath);
            log.info(`Downloaded OCR model ${languageCode} (${Math.round(downloadedSize / (1024 * 1024))}MB)`);
            return;
        } catch (err) {
            const classified = classifyDownloadError(languageCode, err);

            if (!classified.retryable) {
                throw new Error(classified.message);
            }

            if (attempt >= DOWNLOAD_RETRIES) {
                throw new Error(
                    `Failed to download OCR language model "${languageCode}" after ${DOWNLOAD_RETRIES} attempts: ${classified.message}`,
                );
            }

            log.warn(`Download retry scheduled for OCR model ${languageCode}: ${classified.message}`);
            await delay(RETRY_DELAY_MS * attempt);
        } finally {
            await rm(tempPath, { force: true }).catch(() => {});
        }
    }
}

async function ensureLanguageModel(languageCode: string, runtimeDir: string) {
    if (existsSync(getModelPath(runtimeDir, languageCode))) {
        return;
    }

    const pending = inFlightDownloads.get(languageCode);
    if (pending) {
        await pending;
        return;
    }

    const task = (async () => {
        await downloadLanguageModel(languageCode, runtimeDir);
    })();

    inFlightDownloads.set(languageCode, task);
    try {
        await task;
    } finally {
        inFlightDownloads.delete(languageCode);
    }
}

export async function ensureTessdataLanguages(languageCodes: string[]) {
    const requiredCodes = normalizeLanguageCodes(languageCodes);
    if (requiredCodes.length === 0) {
        return;
    }
    if (requiredCodes.length > OCR_MAX_UNIQUE_MODEL_CODES) {
        throw new Error(`Too many OCR languages requested (${requiredCodes.length})`);
    }
    for (const languageCode of requiredCodes) {
        if (!AVAILABLE_OCR_LANGUAGE_CODES.has(languageCode)) {
            throw new Error(`Unsupported OCR language: ${languageCode}`);
        }
    }

    const runtimeDir = getRuntimeTessdataDir();
    await seedBundledModels(runtimeDir);
    // Bound parallel model downloads so OCR requests cannot flood network/disk resources.
    await forEachConcurrent(requiredCodes, OCR_MODEL_DOWNLOAD_CONCURRENCY, async (languageCode) => {
        await ensureLanguageModel(languageCode, runtimeDir);
    });
}
