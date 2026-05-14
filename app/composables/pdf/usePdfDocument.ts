import pdfjsLib from '@app/services/pdfjs/runtimeLib';
import { clamp } from 'es-toolkit/math';
import type {
    PDFDataRangeTransport,
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
import type {
    IPdfPageMetric,
    TPdfSource,
} from '@app/types/pdf';
import { BrowserLogger } from '@app/utils/browserLogger';
import { guardAsync } from '@app/utils/asyncGuard';
import { readDocumentRange } from '@app/utils/platformDocuments';
import {
    getPdfjsAssetDir,
    getPdfjsWorkerUrl,
} from '@app/utils/viewerAssets';

pdfjsLib.GlobalWorkerOptions.workerSrc = getPdfjsWorkerUrl();

type TPdfDataRangeTransportCtor = new (
    length: number,
    initialData: Uint8Array,
) => PDFDataRangeTransport;

export const MAX_CACHED_PDF_PAGES = 48;

function destroyPdfDocumentDeferred(
    document: PDFDocumentProxy,
    message: string,
) {
    try {
        guardAsync(document.destroy(), {
            scope: 'pdf-document',
            message,
            onError: (error) => {
                BrowserLogger.error(
                    'pdf-document',
                    message,
                    error,
                );
            },
        });
    } catch (error) {
        BrowserLogger.error(
            'pdf-document',
            message,
            error,
        );
    }
}

function createStalePdfDocumentError(message: string) {
    const error = new Error(message);
    error.name = 'RenderingCancelledException';
    return error;
}

export const usePdfDocument = () => {
    const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
    const numPages = ref(0);
    const isLoading = ref(false);
    const basePageWidth = ref<number | null>(null);
    const basePageHeight = ref<number | null>(null);
    const pageMetrics = ref<IPdfPageMetric[]>([]);
    const pageMetricsVersion = ref(0);

    let renderVersion = 0;
    const pdfPageCache = new Map<number, PDFPageProxy>();
    const pageMetricLoads = new Map<number, Promise<IPdfPageMetric | null>>();
    let objectUrl: string | null = null;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    let rangeTransport: PDFDataRangeTransport | null = null;

    function getPdfjsDocumentOptions() {
        return {
            verbosity: pdfjsLib.VerbosityLevel.ERRORS,
            standardFontDataUrl: getPdfjsAssetDir('standard_fonts'),
            cMapUrl: getPdfjsAssetDir('cmaps'),
            cMapPacked: true,
            wasmUrl: getPdfjsAssetDir('wasm'),
            iccUrl: getPdfjsAssetDir('iccs'),
            useSystemFonts: false,
        };
    }

    function touchCachedPage(pageNumber: number, page: PDFPageProxy) {
        pdfPageCache.delete(pageNumber);
        pdfPageCache.set(pageNumber, page);
    }

    function rememberCachedPage(pageNumber: number, page: PDFPageProxy) {
        touchCachedPage(pageNumber, page);
        while (pdfPageCache.size > MAX_CACHED_PDF_PAGES) {
            const oldestPageNumber = pdfPageCache.keys().next().value;
            if (typeof oldestPageNumber !== 'number') {
                break;
            }
            pdfPageCache.delete(oldestPageNumber);
        }
    }

    function isValidPageMetric(
        metric: IPdfPageMetric | null | undefined,
    ): metric is IPdfPageMetric {
        return typeof metric?.width === 'number'
            && Number.isFinite(metric.width)
            && metric.width > 0
            && typeof metric.height === 'number'
            && Number.isFinite(metric.height)
            && metric.height > 0;
    }

    function getRenderVersion() {
        return renderVersion;
    }

    function incrementRenderVersion() {
        pageMetricLoads.clear();
        return ++renderVersion;
    }

    function bumpPageMetricsVersion() {
        pageMetricsVersion.value += 1;
    }

    function updateBaseMetrics(metric: IPdfPageMetric) {
        basePageWidth.value = Math.max(basePageWidth.value ?? 0, metric.width);
        basePageHeight.value = Math.max(basePageHeight.value ?? 0, metric.height);
    }

    async function loadPageMetric(
        document: PDFDocumentProxy,
        pageNumber: number,
        version: number,
    ): Promise<IPdfPageMetric | null> {
        if (pageNumber < 1 || pageNumber > document.numPages) {
            return null;
        }

        const cachedMetric = pageMetrics.value[pageNumber - 1];
        if (isValidPageMetric(cachedMetric)) {
            return cachedMetric;
        }

        const inFlight = pageMetricLoads.get(pageNumber);
        if (inFlight) {
            return inFlight;
        }

        let loadPromise: Promise<IPdfPageMetric | null> | null = null;
        loadPromise = (async () => {
            const page = await document.getPage(pageNumber);
            try {
                if (version !== renderVersion || document !== pdfDocument.value) {
                    return null;
                }

                const viewport = page.getViewport({ scale: 1 });
                const metric = {
                    width: viewport.width,
                    height: viewport.height,
                } satisfies IPdfPageMetric;
                if (!isValidPageMetric(metric)) {
                    return null;
                }

                pageMetrics.value[pageNumber - 1] = metric;
                updateBaseMetrics(metric);
                bumpPageMetricsVersion();
                return metric;
            } finally {
                if (typeof page.cleanup === 'function') {
                    page.cleanup();
                }
            }
        })().finally(() => {
            if (loadPromise && pageMetricLoads.get(pageNumber) === loadPromise) {
                pageMetricLoads.delete(pageNumber);
            }
        });

        pageMetricLoads.set(pageNumber, loadPromise);
        return loadPromise;
    }

    async function ensurePageMetricsInRange(
        startPage: number,
        endPage: number,
    ) {
        const document = pdfDocument.value;
        const totalPages = numPages.value;
        if (!document || totalPages <= 0) {
            return false;
        }

        const rangeStart = clamp(Math.min(startPage, endPage), 1, totalPages);
        const rangeEnd = clamp(Math.max(startPage, endPage), 1, totalPages);
        const pagesToLoad: number[] = [];

        for (let pageNumber = rangeStart; pageNumber <= rangeEnd; pageNumber += 1) {
            if (!isValidPageMetric(pageMetrics.value[pageNumber - 1])) {
                pagesToLoad.push(pageNumber);
            }
        }

        if (pagesToLoad.length === 0) {
            return false;
        }

        const version = renderVersion;
        const concurrency = Math.min(4, pagesToLoad.length);
        let nextPageIndex = 0;

        await Promise.all(Array.from({ length: concurrency }, async () => {
            while (nextPageIndex < pagesToLoad.length) {
                const pageNumber = pagesToLoad[nextPageIndex]!;
                nextPageIndex += 1;
                if (version !== renderVersion) {
                    return;
                }
                await loadPageMetric(document, pageNumber, version);
            }
        }));

        return version === renderVersion && document === pdfDocument.value;
    }

    async function primeInitialPageMetrics(
        document: PDFDocumentProxy,
        version: number,
    ) {
        if (document.numPages <= 0) {
            pageMetrics.value = [];
            basePageWidth.value = null;
            basePageHeight.value = null;
            bumpPageMetricsVersion();
            return;
        }

        await loadPageMetric(document, 1, version);
        if (version !== renderVersion || document !== pdfDocument.value) {
            return;
        }

        const firstMetric = pageMetrics.value[0];
        if (!isValidPageMetric(firstMetric)) {
            pageMetrics.value = [];
            basePageWidth.value = null;
            basePageHeight.value = null;
            bumpPageMetricsVersion();
            return;
        }

    }

    async function acceptLoadedDocument(
        document: PDFDocumentProxy,
        version: number,
    ) {
        // Discard stale result if a newer load was started
        if (version !== renderVersion) {
            destroyPdfDocumentDeferred(document, 'Failed to destroy stale PDF document');
            return null;
        }

        pdfDocument.value = document;
        numPages.value = document.numPages;
        await primeInitialPageMetrics(document, version);
        if (version !== renderVersion || document !== pdfDocument.value) {
            return null;
        }

        return {
            version,
            document,
        };
    }

    function preserveLoadState(shouldPreserve: boolean) {
        return {
            numPages: shouldPreserve ? numPages.value : 0,
            basePageWidth: shouldPreserve ? basePageWidth.value : null,
            basePageHeight: shouldPreserve ? basePageHeight.value : null,
            pageMetrics: shouldPreserve
                ? pageMetrics.value.map(metric => ({ ...metric }))
                : [],
        };
    }

    function restorePreservedLoadState(
        state: ReturnType<typeof preserveLoadState>,
    ) {
        numPages.value = state.numPages;
        basePageWidth.value = state.basePageWidth;
        basePageHeight.value = state.basePageHeight;
        pageMetrics.value = state.pageMetrics;
        bumpPageMetricsVersion();
    }

    function resetLoadMetadata() {
        basePageWidth.value = null;
        basePageHeight.value = null;
        pageMetrics.value = [];
        bumpPageMetricsVersion();
    }

    function startLoad(
        options: { preservePageStructure?: boolean } | undefined,
    ) {
        const shouldPreservePageStructure = options?.preservePageStructure === true;
        const savedState = preserveLoadState(shouldPreservePageStructure);

        // Cancel any in-progress load - latest wins
        cleanup();

        if (shouldPreservePageStructure) {
            restorePreservedLoadState(savedState);
        }

        const version = incrementRenderVersion();
        isLoading.value = true;
        if (!shouldPreservePageStructure) {
            resetLoadMetadata();
        }

        return version;
    }

    function finishLoad(version: number) {
        // Only clear loading state if this is still the current load
        if (version === renderVersion) {
            isLoading.value = false;
        }
    }

    function handleLoadError(
        error: unknown,
        version: number,
    ) {
        // Ignore cancellation errors from destroyed loading tasks
        if (version !== renderVersion) {
            return null;
        }
        BrowserLogger.error('pdf-document', 'Failed to load PDF', error);
        return null;
    }

    function destroyLoadingTaskAfterRangeReadFailure() {
        if (!loadingTask) {
            return;
        }

        try {
            guardAsync(loadingTask.destroy(), {
                scope: 'pdf-document',
                message: 'PDF loading task destroy rejected after range read failure',
                onError: (destroyError) => {
                    BrowserLogger.debug(
                        'pdf-document',
                        'PDF loading task destroy rejected after range read failure',
                        destroyError,
                    );
                },
            });
        } catch (destroyError) {
            BrowserLogger.debug(
                'pdf-document',
                'Failed to destroy PDF loading task after range read failure',
                destroyError,
            );
        }
    }

    function createRangeReadFailureHandler() {
        let rejectRangeReadFailure: ((error: Error) => void) | null = null;
        const rangeReadFailure = new Promise<never>((_resolve, reject) => {
            rejectRangeReadFailure = reject;
        });

        const failRangeRead = (error: unknown) => {
            if (!rejectRangeReadFailure) {
                return;
            }

            const reject = rejectRangeReadFailure;
            rejectRangeReadFailure = null;
            reject(error instanceof Error ? error : new Error(String(error)));
        };

        return {
            rangeReadFailure,
            failRangeRead,
            complete: () => {
                rejectRangeReadFailure = null;
            },
        };
    }

    function attachRangeRequestHandler(
        transport: PDFDataRangeTransport,
        src: Extract<TPdfSource, { kind: 'path' }>,
        version: number,
        failRangeRead: (error: unknown) => void,
    ) {
        // PDF.js will call this to request additional chunks.
        transport.requestDataRange = (
            begin: number,
            end: number,
        ) => {
            void (async () => {
                try {
                    // Drop stale reads if a newer load has started.
                    if (version !== renderVersion) {
                        return;
                    }
                    const chunk = await readDocumentRange(src.path, begin, end - begin);
                    if (version !== renderVersion) {
                        return;
                    }
                    transport.onDataRange(begin, chunk);
                } catch (error) {
                    if (version !== renderVersion) {
                        return;
                    }

                    BrowserLogger.error(
                        'pdf-document',
                        'Failed to read PDF range chunk',
                        error,
                    );
                    failRangeRead(error);
                    destroyLoadingTaskAfterRangeReadFailure();
                }
            })();
        };
    }

    async function loadPdfFromBlob(
        src: Blob,
        version: number,
    ) {
        if (version !== renderVersion) {
            return null;
        }

        objectUrl = URL.createObjectURL(src);
        loadingTask = pdfjsLib.getDocument({
            url: objectUrl,
            ...getPdfjsDocumentOptions(),
        });

        const pdfDoc = await loadingTask.promise;
        return acceptLoadedDocument(pdfDoc, version);
    }

    async function loadPdfFromPath(
        src: Extract<TPdfSource, { kind: 'path' }>,
        version: number,
    ) {
        // Large PDFs: avoid reading the full file into renderer memory. Use range reads via IPC.
        const length = src.size;
        const CHUNK = 1024 * 1024;
        const initialLen = Math.min(CHUNK, length);

        // Read the head (PDF header/catalog) and tail (xref/trailer)
        // in parallel so both are available before getDocument starts.
        const tailStart = Math.max(initialLen, length - CHUNK);
        const needsTail = tailStart > initialLen;
        const [
            initialData,
            tailData,
        ] = await Promise.all([
            readDocumentRange(src.path, 0, initialLen),
            needsTail
                ? readDocumentRange(src.path, tailStart, length - tailStart)
                : Promise.resolve(null),
        ]);

        if (version !== renderVersion) {
            return null;
        }

        const TransportCtor = (
            pdfjsLib as typeof pdfjsLib & {PDFDataRangeTransport?: TPdfDataRangeTransportCtor;}
        ).PDFDataRangeTransport;
        if (!TransportCtor) {
            BrowserLogger.error(
                'pdf-document',
                'Failed to load PDF',
                new Error('PDF.js range transport API is unavailable'),
            );
            return null;
        }

        rangeTransport = new TransportCtor(
            length,
            initialData,
        );
        const activeRangeTransport = rangeTransport;

        // Pre-deliver the tail chunk so the worker finds the xref
        // without waiting for a requestDataRange round-trip.
        if (tailData) {
            activeRangeTransport.onDataRange(tailStart, tailData);
        }

        const rangeFailure = createRangeReadFailureHandler();
        attachRangeRequestHandler(
            activeRangeTransport,
            src,
            version,
            rangeFailure.failRangeRead,
        );

        loadingTask = pdfjsLib.getDocument({
            range: activeRangeTransport,
            length,
            rangeChunkSize: 1024 * 1024,
            disableAutoFetch: true,
            ...getPdfjsDocumentOptions(),
        });

        const activeLoadingTask = loadingTask;
        const pdfDoc = await Promise.race([
            activeLoadingTask.promise,
            rangeFailure.rangeReadFailure,
        ]);
        rangeFailure.complete();

        return acceptLoadedDocument(pdfDoc, version);
    }

    async function loadPdf(
        src: TPdfSource,
        options?: { preservePageStructure?: boolean },
    ) {
        const version = startLoad(options);

        try {
            if (src instanceof Blob) {
                return await loadPdfFromBlob(src, version);
            }

            return await loadPdfFromPath(src, version);
        } catch (error) {
            return handleLoadError(error, version);
        } finally {
            finishLoad(version);
        }
    }

    async function getPage(pageNumber: number) {
        const document = pdfDocument.value;
        const version = renderVersion;

        if (!document) {
            throw new Error('No PDF document loaded');
        }

        let page = pdfPageCache.get(pageNumber);
        if (!page) {
            page = await document.getPage(pageNumber);
            if (version !== renderVersion || document !== pdfDocument.value) {
                page.cleanup();
                throw createStalePdfDocumentError(
                    'Rendering cancelled: PDF page request became stale',
                );
            }
            rememberCachedPage(pageNumber, page);
        } else {
            touchCachedPage(pageNumber, page);
        }
        return page;
    }

    function evictPage(pageNumber: number) {
        const page = pdfPageCache.get(pageNumber);
        if (!page) {
            return;
        }

        page.cleanup();
        pdfPageCache.delete(pageNumber);
    }

    function cleanupPageCache() {
        for (const [
            , page,
        ] of pdfPageCache) {
            page.cleanup();
        }
        pdfPageCache.clear();
    }

    async function saveDocument(): Promise<Uint8Array | null> {
        if (!pdfDocument.value) {
            return null;
        }
        return pdfDocument.value.saveDocument();
    }

    function cleanup() {
        incrementRenderVersion();
        isLoading.value = false;
        cleanupPageCache();
        pageMetricLoads.clear();
        if (rangeTransport) {
            try {
                rangeTransport.abort();
            } catch (error) {
                BrowserLogger.debug(
                    'pdf-document',
                    'Failed to abort PDF range transport',
                    error,
                );
            } finally {
                rangeTransport = null;
            }
        }

        if (loadingTask) {
            try {
                guardAsync(loadingTask.destroy(), {
                    scope: 'pdf-document',
                    message: 'PDF loading task destroy rejected',
                    onError: (error) => {
                        BrowserLogger.debug(
                            'pdf-document',
                            'PDF loading task destroy rejected',
                            error,
                        );
                    },
                });
            } catch (error) {
                BrowserLogger.error(
                    'pdf-document',
                    'Failed to destroy PDF loading task',
                    error,
                );
            } finally {
                loadingTask = null;
            }
        }

        if (pdfDocument.value) {
            destroyPdfDocumentDeferred(pdfDocument.value, 'Failed to destroy PDF document');
            pdfDocument.value = null;
        }

        if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
        }

        numPages.value = 0;
        basePageWidth.value = null;
        basePageHeight.value = null;
        pageMetrics.value = [];
        bumpPageMetricsVersion();
    }

    return {
        pdfDocument,
        numPages,
        isLoading,
        basePageWidth,
        basePageHeight,
        pageMetrics,
        pageMetricsVersion,
        getRenderVersion,
        incrementRenderVersion,
        loadPdf,
        ensurePageMetricsInRange,
        getPage,
        evictPage,
        cleanupPageCache,
        saveDocument,
        cleanup,
    };
};
