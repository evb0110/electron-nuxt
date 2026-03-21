import pdfjsLib from '@app/services/pdfjs/runtime-lib';
import type {
    PDFDataRangeTransport,
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
import { getElectronAPI } from '@app/utils/platform';
import type {
    IPdfPageMetric,
    TPdfSource,
} from '@app/types/pdf';
import { BrowserLogger } from '@app/utils/browser-logger';
import { guardAsync } from '@app/utils/async-guard';
import { resolveDocumentBaseMetric } from '@app/composables/pdf/pdfPageLayout';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf/pdf.worker.min.mjs';

type TPdfDataRangeTransportCtor = new (
    length: number,
    initialData: Uint8Array,
) => PDFDataRangeTransport;

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

export const usePdfDocument = () => {
    const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
    const numPages = ref(0);
    const isLoading = ref(false);
    const basePageWidth = ref<number | null>(null);
    const basePageHeight = ref<number | null>(null);
    const pageMetrics = ref<IPdfPageMetric[]>([]);

    let renderVersion = 0;
    const pdfPageCache = new Map<number, PDFPageProxy>();
    const pageMetricLoads = new Map<number, Promise<IPdfPageMetric | null>>();
    let objectUrl: string | null = null;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    let rangeTransport: PDFDataRangeTransport | null = null;

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

    function syncBaseMetrics(metrics: IPdfPageMetric[]) {
        basePageWidth.value = resolveDocumentBaseMetric(metrics, 'width');
        basePageHeight.value = resolveDocumentBaseMetric(metrics, 'height');
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
                if (version !== renderVersion) {
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
                syncBaseMetrics(pageMetrics.value);
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

        const rangeStart = Math.max(1, Math.min(startPage, endPage));
        const rangeEnd = Math.min(totalPages, Math.max(startPage, endPage));
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

        return version === renderVersion;
    }

    async function primeInitialPageMetrics(
        document: PDFDocumentProxy,
        version: number,
    ) {
        if (document.numPages <= 0) {
            pageMetrics.value = [];
            basePageWidth.value = null;
            basePageHeight.value = null;
            return;
        }

        await loadPageMetric(document, 1, version);
        if (version !== renderVersion) {
            return;
        }

        const firstMetric = pageMetrics.value[0];
        if (!isValidPageMetric(firstMetric)) {
            pageMetrics.value = [];
            basePageWidth.value = null;
            basePageHeight.value = null;
            return;
        }

        syncBaseMetrics(pageMetrics.value);
    }

    async function loadPdf(
        src: TPdfSource,
        options?: { preservePageStructure?: boolean },
    ) {
        const savedNumPages = options?.preservePageStructure ? numPages.value : 0;
        const savedBaseWidth = options?.preservePageStructure
            ? basePageWidth.value
            : null;
        const savedBaseHeight = options?.preservePageStructure
            ? basePageHeight.value
            : null;
        const savedPageMetrics = options?.preservePageStructure
            ? pageMetrics.value.map(metric => ({ ...metric }))
            : [];

        // Cancel any in-progress load - latest wins
        cleanup();

        if (options?.preservePageStructure) {
            numPages.value = savedNumPages;
            basePageWidth.value = savedBaseWidth;
            basePageHeight.value = savedBaseHeight;
            pageMetrics.value = savedPageMetrics;
        }

        const version = incrementRenderVersion();
        isLoading.value = true;
        if (!options?.preservePageStructure) {
            basePageWidth.value = null;
            basePageHeight.value = null;
            pageMetrics.value = [];
        }

        try {
            if (src instanceof Blob) {
                objectUrl = URL.createObjectURL(src);
                loadingTask = pdfjsLib.getDocument({
                    url: objectUrl,
                    verbosity: pdfjsLib.VerbosityLevel.ERRORS,
                    standardFontDataUrl: '/pdf/standard_fonts/',
                    cMapUrl: '/pdf/cmaps/',
                    cMapPacked: true,
                    wasmUrl: '/pdf/wasm/',
                    iccUrl: '/pdf/iccs/',
                    useSystemFonts: false,
                });
            } else {
                // Large PDFs: avoid reading the full file into renderer memory. Use range reads via IPC.
                const api = getElectronAPI();
                const length = src.size;
                const initialLen = Math.min(1024 * 1024, length);
                const initialData = await api.documents.readFileRange(src.path, 0, initialLen);

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

                // PDF.js will call this to request additional chunks.
                activeRangeTransport.requestDataRange = (
                    begin: number,
                    end: number,
                ) => {
                    void (async () => {
                        try {
                            // Drop stale reads if a newer load has started.
                            if (version !== renderVersion) {
                                return;
                            }
                            const chunk = await api.documents.readFileRange(src.path, begin, end - begin);
                            activeRangeTransport.onDataRange(begin, chunk);
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
                            if (loadingTask) {
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
                        }
                    })();
                };

                loadingTask = pdfjsLib.getDocument({
                    range: activeRangeTransport,
                    length,
                    rangeChunkSize: 1024 * 1024,
                    verbosity: pdfjsLib.VerbosityLevel.ERRORS,
                    standardFontDataUrl: '/pdf/standard_fonts/',
                    cMapUrl: '/pdf/cmaps/',
                    cMapPacked: true,
                    wasmUrl: '/pdf/wasm/',
                    iccUrl: '/pdf/iccs/',
                    useSystemFonts: false,
                });

                const activeLoadingTask = loadingTask;
                const pdfDoc = await Promise.race([
                    activeLoadingTask.promise,
                    rangeReadFailure,
                ]);
                rejectRangeReadFailure = null;

                // Discard stale result if a newer load was started
                if (version !== renderVersion) {
                    destroyPdfDocumentDeferred(pdfDoc, 'Failed to destroy stale PDF document');
                    return null;
                }

                pdfDocument.value = pdfDoc;
                numPages.value = pdfDoc.numPages;
                await primeInitialPageMetrics(pdfDoc, version);

                return {
                    version,
                    document: pdfDoc,
                };
            }

            if (!loadingTask) {
                return null;
            }
            const pdfDoc = await loadingTask.promise;

            // Discard stale result if a newer load was started
            if (version !== renderVersion) {
                destroyPdfDocumentDeferred(pdfDoc, 'Failed to destroy stale PDF document');
                return null;
            }

            pdfDocument.value = pdfDoc;
            numPages.value = pdfDoc.numPages;
            await primeInitialPageMetrics(pdfDoc, version);

            return {
                version,
                document: pdfDoc,
            };
        } catch (error) {
            // Ignore cancellation errors from destroyed loading tasks
            if (version !== renderVersion) {
                return null;
            }
            BrowserLogger.error('pdf-document', 'Failed to load PDF', error);
            return null;
        } finally {
            // Only clear loading state if this is still the current load
            if (version === renderVersion) {
                isLoading.value = false;
            }
        }
    }

    async function getPage(pageNumber: number) {
        if (!pdfDocument.value) {
            throw new Error('No PDF document loaded');
        }

        let page = pdfPageCache.get(pageNumber);
        if (!page) {
            page = await pdfDocument.value.getPage(pageNumber);
            pdfPageCache.set(pageNumber, page);
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
    }

    return {
        pdfDocument,
        numPages,
        isLoading,
        basePageWidth,
        basePageHeight,
        pageMetrics,
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
