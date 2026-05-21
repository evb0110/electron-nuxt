import {
    createScheduler,
    createWorker,
} from 'tesseract.js';
import { uniq } from 'es-toolkit/array';
import {
    clamp,
    sumBy,
} from 'es-toolkit/math';
import type { IOcrCapability } from '@contracts/platformApi';
import type { IOcrLanguage } from '@contracts/shared';
import { AVAILABLE_OCR_LANGUAGES } from '@contracts/ocrLanguages';
import {
    cacheBrowserOcrLanguageData,
    hasCachedBrowserOcrLanguage,
    hydrateBrowserOcrLanguageCache,
    listInstalledBrowserOcrLanguages,
    markBrowserOcrLanguageInstalled,
} from '@app/platform/browser-api/browserOcrLanguageStore';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';
import { getBrowserOcrLanguageBaseUrl } from '@app/utils/browserOcrConfig';
import { getErrorMessage } from '@app/utils/error';

const LARGE_PAGE_PIXELS = 10_000_000;
const LOW_MEMORY_DEVICE_GB = 4;

type TOcrRequest = Parameters<IOcrCapability['recognizeBatch']>[0][number];
type TOcrProgress = Parameters<IOcrCapability['onProgress']>[0] extends (progress: infer TProgress) => void
    ? TProgress
    : never;
type TProgressCallback = (progress: TOcrProgress) => void;

const progressCallbacks = new Set<TProgressCallback>();
const installedBrowserOcrLanguages = new Set<string>();

function emitProgress(progress: TOcrProgress) {
    for (const callback of progressCallbacks) {
        callback(progress);
    }
}

function normalizeLanguageCodes(languages: string[]) {
    return uniq(languages
        .map(language => language.trim())
        .filter(language => language.length > 0));
}

function getNavigatorNumber(key: 'hardwareConcurrency' | 'deviceMemory') {
    if (typeof navigator === 'undefined') {
        return undefined;
    }

    const value = (navigator as Navigator & { deviceMemory?: number })[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function resolveBrowserOcrWorkerCount(options: {
    pageCount: number;
    hardwareConcurrency?: number;
    deviceMemoryGb?: number;
    totalPixels: number;
}) {
    if (
        options.pageCount <= 1
        || options.totalPixels / Math.max(options.pageCount, 1) >= LARGE_PAGE_PIXELS
        || (options.deviceMemoryGb ?? LOW_MEMORY_DEVICE_GB) <= LOW_MEMORY_DEVICE_GB
    ) {
        return 1;
    }

    const availableCores = Math.max(1, Math.floor((options.hardwareConcurrency ?? 2) / 3));
    return clamp(options.pageCount, 1, Math.min(3, availableCores));
}

async function ensureLanguageInstalled(code: string) {
    if (await hasCachedBrowserOcrLanguage(code)) {
        await hydrateBrowserOcrLanguageCache(code);
        await markBrowserOcrLanguageInstalled(code);
        return;
    }

    const sourceUrl = `${getBrowserOcrLanguageBaseUrl().replace(/\/$/u, '')}/${code}.traineddata`;
    const response = await fetch(sourceUrl);
    if (!response.ok) {
        throw new Error(`Failed to download OCR language ${code}`);
    }

    const data = new Uint8Array(await response.arrayBuffer());
    await cacheBrowserOcrLanguageData(code, data);
    await markBrowserOcrLanguageInstalled(code, {
        sizeBytes: data.byteLength,
        sourceUrl,
    });
}

async function createOcrWorker(languages: string[]) {
    const worker = await createWorker(languages.join('+'));
    return worker;
}

async function runRecognitionJobs(
    pages: TOcrRequest[],
    requestId: string,
    workerCount: number,
) {
    const scheduler = createScheduler();
    const languages = normalizeLanguageCodes(pages.flatMap(page => page.languages));
    const workers = [];
    try {
        for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
            workers.push(await createOcrWorker(languages));
        }
    } catch (error) {
        await Promise.allSettled(workers.map(worker => worker.terminate()));
        await scheduler.terminate();
        throw error;
    }

    for (const worker of workers) {
        scheduler.addWorker(worker);
    }

    const activePages = new Set<number>();
    let processedCount = 0;
    const results: Record<number, string> = {};
    const errors: string[] = [];

    try {
        let nextPageIndex = 0;
        const runNextPage = async (): Promise<void> => {
            const page = pages[nextPageIndex];
            nextPageIndex += 1;
            if (!page) {
                return;
            }

            activePages.add(page.pageNumber);
            emitProgress({
                requestId,
                phase: 'processing',
                currentPage: page.pageNumber,
                processedCount,
                totalPages: pages.length,
                activePages: [...activePages],
                phaseProgress: Math.round((processedCount / pages.length) * 100),
            });

            try {
                const result = await scheduler.addJob(
                    'recognize',
                    page.imageData as never,
                    {},
                    {},
                    String(page.pageNumber),
                ) as { data?: { text?: string } };
                results[page.pageNumber] = result.data?.text ?? '';
            } catch (error) {
                errors.push(getErrorMessage(error));
            } finally {
                activePages.delete(page.pageNumber);
                processedCount += 1;
                emitProgress({
                    requestId,
                    phase: 'processing',
                    currentPage: page.pageNumber,
                    processedCount,
                    totalPages: pages.length,
                    activePages: [...activePages],
                    phaseProgress: Math.round((processedCount / pages.length) * 100),
                });
            }
            await runNextPage();
        };

        await Promise.all(Array.from({ length: workerCount }, () => runNextPage()));
    } finally {
        await scheduler.terminate();
    }

    return {
        results,
        errors,
    };
}

export async function getBrowserOcrLanguages(): Promise<Array<IOcrLanguage & { installed: boolean }>> {
    const installedLanguages = await listInstalledBrowserOcrLanguages();
    return AVAILABLE_OCR_LANGUAGES.map(language => ({
        ...language,
        installed: installedLanguages.has(language.code) || installedBrowserOcrLanguages.has(language.code),
    }));
}

async function installLanguages(languages: string[], requestId: string) {
    const normalizedLanguages = normalizeLanguageCodes(languages);
    const installed: string[] = [];
    const errors: string[] = [];

    for (const languageCode of normalizedLanguages) {
        emitProgress({
            requestId,
            phase: 'preparing',
            languageCode,
            currentPage: 0,
            processedCount: installed.length,
            totalPages: normalizedLanguages.length,
            phaseProgress: Math.round((installed.length / Math.max(normalizedLanguages.length, 1)) * 100),
        });

        try {
            await ensureLanguageInstalled(languageCode);
            installedBrowserOcrLanguages.add(languageCode);
            installed.push(languageCode);
        } catch (error) {
            errors.push(getErrorMessage(error));
        }
    }

    const result = {
        started: errors.length === 0,
        jobId: requestId,
        installed,
        errors,
    };
    if (errors[0] !== undefined) {
        return {
            ...result,
            error: errors[0],
        };
    }
    return result;
}

export const browserOcrCapability: IOcrCapability = {
    async recognize(request) {
        const batchResult = await this.recognizeBatch([request], `browser-ocr-${request.pageNumber}`);
        const result = {
            pageNumber: request.pageNumber,
            success: batchResult.errors.length === 0,
            text: batchResult.results[request.pageNumber] ?? '',
        };
        const error = batchResult.errors[0];
        return error === undefined
            ? result
            : {
                ...result,
                error,
            };
    },
    async recognizeBatch(pages, requestId) {
        if (pages.length === 0) {
            return {
                results: {},
                errors: [],
            };
        }

        const languages = normalizeLanguageCodes(pages.flatMap(page => page.languages));
        const installResult = await installLanguages(languages, requestId);
        if (installResult.errors.length > 0) {
            return {
                results: {},
                errors: installResult.errors,
            };
        }

        const totalPixels = sumBy(pages, page => (page.imageWidth ?? 0) * (page.imageHeight ?? 0));
        const workerOptions = {
            pageCount: pages.length,
            totalPixels,
        };
        const hardwareConcurrency = getNavigatorNumber('hardwareConcurrency');
        const deviceMemoryGb = getNavigatorNumber('deviceMemory');
        const workerCount = resolveBrowserOcrWorkerCount({
            ...workerOptions,
            ...(hardwareConcurrency !== undefined ? { hardwareConcurrency } : {}),
            ...(deviceMemoryGb !== undefined ? { deviceMemoryGb } : {}),
        });

        return runRecognitionJobs(pages, requestId, workerCount);
    },
    cancel(_requestId) {
        return Promise.resolve({ canceled: false });
    },
    getLanguages: getBrowserOcrLanguages,
    installLanguages,
    acknowledgeResultFile(_requestId, _pdfPath) {
        return Promise.resolve({ cleaned: true });
    },
    createSearchablePdf(_sourcePdfPath, _pages, _requestId, _renderDpi) {
        return Promise.resolve({
            started: false,
            jobId: '',
            error: 'Searchable browser OCR PDF generation is not available',
        });
    },
    onProgress(callback) {
        progressCallbacks.add(callback);
        return () => progressCallbacks.delete(callback);
    },
    onComplete: noopUnsubscribe,
    preprocessing: {
        validate() {
            return Promise.resolve({
                valid: typeof Worker === 'function',
                available: typeof Worker === 'function' ? ['browser-ocr'] : [],
                missing: typeof Worker === 'function' ? [] : ['browser-ocr'],
            });
        },
        preprocessPage(imageData) {
            return Promise.resolve({
                success: true,
                imageData,
            });
        },
    },
};
