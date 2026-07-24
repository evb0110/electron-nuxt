import type {
    DJVU_PLATFORM_FEATURE,
    IDjvuCapability,
} from '@contracts/djvuPlatformFeature';
import type { TFeatureBrowserBindings } from '@contracts/platformFeature';
import {
    browserDocumentStore,
    isBrowserDocumentRef,
} from '@app/platform/browserDocumentStore';
import {
    releaseBrowserDjvuViewingWorker,
    retainBrowserDjvuViewingWorker,
} from '@app/platform/browser-api/createDjvuWorkerFromPath';
import { browserDjvuTextSearchCapability } from '@app/platform/browser-api/browserDjvuTextSearchCapability';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';
import { browserDurableDjvuJobs } from '@app/platform/browser-api/browserDurableDjvuJobs';
import { assertBrowserDjvuRasterDimensions } from '@app/platform/browser-api/assertBrowserDjvuRasterDimensions';
import {
    cancelBrowserDjvuConversion,
    estimateBrowserDjvuSizes,
    getBrowserDjvuInfo,
    onBrowserDjvuConversionProgress,
    runBrowserDjvuConversion,
    withBrowserDjvuWorker,
} from '@app/platform/browser-api/browserDjvuConversionPipeline';

export const browserDjvuCapability: IDjvuCapability = {
    startOpenForViewing(djvuPath, requestId) {
        const jobId = `djvu-open-${requestId}`;
        return Promise.resolve(browserDurableDjvuJobs.startOpen(
            jobId,
            requestId,
            () => browserDjvuCapability.openForViewing(djvuPath),
        ));
    },
    awaitOpenJob(jobId) {
        return browserDurableDjvuJobs.awaitOpen(jobId);
    },
    async openForViewing(djvuPath) {
        if (!isBrowserDocumentRef(djvuPath)) {
            return withBrowserDjvuWorker(djvuPath, async (worker) => {
                const pageSizes = await worker.doc.getPagesSizes().run();
                return pageSizes.length > 0
                    ? {
                        success: true,
                        pageCount: pageSizes.length,
                    }
                    : {
                        success: false,
                        error: 'DjVu document has no pages',
                    };
            });
        }
        try {
            const worker = await retainBrowserDjvuViewingWorker(djvuPath);
            const pageSizes = await worker.doc.getPagesSizes().run();
            const pageCount = pageSizes.length;

            if (pageCount <= 0) {
                releaseBrowserDjvuViewingWorker(djvuPath);
                return {
                    success: false,
                    error: 'DjVu document has no pages',
                };
            }
            return {
                success: true,
                pageCount,
            };
        } catch (error: unknown) {
            releaseBrowserDjvuViewingWorker(djvuPath);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'DjVu viewing failed',
            };
        }
    },
    releaseViewingPath(djvuPath) {
        if (isBrowserDocumentRef(djvuPath)) releaseBrowserDjvuViewingWorker(djvuPath);
        return Promise.resolve();
    },
    cancelPagePreview(_requestId) {
        return Promise.resolve({ canceled: false });
    },
    ...browserDjvuTextSearchCapability,
    convertToPdf: runBrowserDjvuConversion,
    startConvertToPdf(djvuPath, outputPath, options) {
        const requestId = options.requestId ?? crypto.randomUUID();
        const jobId = options.jobId ?? `djvu-convert-${requestId}`;
        return Promise.resolve(browserDurableDjvuJobs.startConvert(
            jobId,
            requestId,
            () => browserDjvuCapability.convertToPdf(djvuPath, outputPath, {
                ...options,
                jobId,
                requestId,
            }),
        ));
    },
    awaitConvertJob(jobId) {
        return browserDurableDjvuJobs.awaitConvert(jobId);
    },
    printDjvuPath() {
        return Promise.resolve({
            success: false,
            error: 'DjVu printing is only available in the desktop app',
        });
    },
    cancel(jobId) {
        return Promise.resolve(cancelBrowserDjvuConversion(jobId));
    },
    getJobState(jobId) {
        return Promise.resolve(browserDurableDjvuJobs.getState(jobId));
    },
    subscribeJob(jobId) {
        return Promise.resolve(browserDurableDjvuJobs.getState(jobId));
    },
    getInfo: getBrowserDjvuInfo,
    getPageSourceInfo(djvuPath, pageNumber) {
        return withBrowserDjvuWorker(djvuPath, async (worker) => {
            const pageSizes = await worker.doc.getPagesSizes().run();
            const effectivePageNumber = Math.min(pageNumber, pageSizes.length);
            const pageSize = pageSizes[effectivePageNumber - 1];
            if (!pageSize) {
                throw new RangeError(`DjVu page ${pageNumber} is outside 1..${pageSizes.length}`);
            }
            return {
                pageCount: pageSizes.length,
                pageNumber: effectivePageNumber,
                pageSize,
            };
        });
    },
    getPageSizes(djvuPath) {
        return withBrowserDjvuWorker(djvuPath, worker => worker.doc.getPagesSizes().run());
    },
    renderPagePreview(djvuPath, pageNumber, _options) {
        return withBrowserDjvuWorker(djvuPath, async (worker) => {
            const pageSize = (await worker.doc.getPagesSizes().run())[pageNumber - 1];
            if (!pageSize) throw new RangeError(`DjVu page ${pageNumber} is outside the document`);
            assertBrowserDjvuRasterDimensions(pageSize.width, pageSize.height, `DjVu page ${pageNumber}`);
            const pageObject = await worker.doc.getPage(pageNumber).createPngObjectUrl().run();
            try {
                const response = await fetch(pageObject.url);
                if (!response.ok) {
                    throw new Error(`Failed to read DjVu page preview: ${response.status}`);
                }
                return {
                    bytes: new Uint8Array(await response.arrayBuffer()),
                    width: pageObject.width,
                    height: pageObject.height,
                };
            } finally {
                worker.revokeObjectURL(pageObject.url);
            }
        });
    },
    estimateSizes: estimateBrowserDjvuSizes,
    async cleanupTemp(tempPdfPath) {
        if (!isBrowserDocumentRef(tempPdfPath)) {
            return;
        }

        if (await browserDocumentStore.exists(tempPdfPath)) {
            await browserDocumentStore.remove(tempPdfPath);
        }
    },
    onProgress: onBrowserDjvuConversionProgress,
    onMenuConvertToPdf: noopUnsubscribe,
} satisfies TFeatureBrowserBindings<typeof DJVU_PLATFORM_FEATURE>;
