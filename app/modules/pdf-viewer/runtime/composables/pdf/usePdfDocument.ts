import pdfjsLib, {
    configurePdfjsWorkerSrc,
    createPdfjsDocumentOptions,
    preparePdfjsBrowserRuntime,
} from '@app/services/pdfjs/runtimeLib';
import { clamp } from 'es-toolkit/math';
import type { TaggedUnion } from 'type-fest';
import type {
    PDFDataRangeTransport,
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
import type {
    IPdfPageMetric,
    TPdfSource,
} from '@app/types/pdfUi';
import { BrowserLogger } from '@app/utils/browserLogger';
import { guardAsync } from '@app/utils/asyncGuard';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { maxCachedPdfPages } from '@app/modules/pdf-viewer/engine/maxCachedPdfPages';
import {
    PDFJS_NATIVE_PREVIEW_MIN_BYTES,
    shouldUseNativePdfPreview,
} from '@app/modules/pdf-viewer/runtime/pdfNativePreviewRouting';

configurePdfjsWorkerSrc(pdfjsLib);

type TPdfDataRangeTransportCtor = new (
    length: number,
    initialData: Uint8Array,
    progressiveDone?: boolean,
) => PDFDataRangeTransport;

interface IPdfPreloadedRange {
    begin: number;
    data: Uint8Array;
}

interface IPdfCachedPageEntry {
    page: PDFPageProxy;
    pageNumber: number;
    leases: number;
    pendingEviction: boolean;
    cleaned: boolean;
}

type TPdfDocumentLoadState = TaggedUnion<'status', {
    idle: { version: number };
    loading: {
        version: number;
        document: PDFDocumentProxy | null;
    };
    ready: {
        version: number;
        document: PDFDocumentProxy;
    };
    failed: {
        version: number;
        error: unknown;
    };
}>;

export interface IPdfDocumentPageLease {
    readonly page: PDFPageProxy;
    release: () => void;
}

interface IPdfDocumentPageLeaseOwner { leasePage: (pageNumber: number) => Promise<IPdfDocumentPageLease> }

const PDF_RANGE_SUBREAD_BYTES = 8 * 1024 * 1024;
const MAX_AGGREGATE_PDF_RANGE_BYTES = 64 * 1024 * 1024;
const pdfDocumentPageLeaseOwners = new WeakMap<PDFDocumentProxy, IPdfDocumentPageLeaseOwner>();

export async function leasePdfDocumentPage(
    document: PDFDocumentProxy,
    pageNumber: number,
) {
    const owner = pdfDocumentPageLeaseOwners.get(document);
    if (!owner) {
        throw new Error('PDF document page lease owner is unavailable');
    }
    return owner.leasePage(pageNumber);
}

function destroyPdfDocumentDeferred(
    document: PDFDocumentProxy,
    message: string,
) {
    try {
        guardAsync(document.destroy(), {
            category: 'background-diagnostic',
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
    const loadState = shallowRef<TPdfDocumentLoadState>({
        status: 'idle',
        version: 0,
    });
    const pdfDocument = computed(() => {
        const state = loadState.value;
        return state.status === 'loading' || state.status === 'ready'
            ? state.document
            : null;
    });
    const numPages = ref(0);
    const isLoading = computed(() => loadState.value.status === 'loading');
    const basePageWidth = ref<number | null>(null);
    const basePageHeight = ref<number | null>(null);
    const pageMetrics = ref<IPdfPageMetric[]>([]);
    const pageMetricsVersion = ref(0);
    const loadError = computed(() => loadState.value.status === 'failed'
        ? loadState.value.error
        : null);

    const pdfPageCache = new Map<number, IPdfCachedPageEntry>();
    const pdfPageEntries = new WeakMap<PDFPageProxy, IPdfCachedPageEntry>();
    const pageMetricLoads = new Map<number, Promise<IPdfPageMetric | null>>();
    let objectUrl: string | null = null;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    let rangeTransport: PDFDataRangeTransport | null = null;

    async function getPdfjsDocumentOptions() {
        await preparePdfjsBrowserRuntime(pdfjsLib);
        return createPdfjsDocumentOptions(pdfjsLib);
    }

    function touchCachedPage(pageNumber: number, entry: IPdfCachedPageEntry) {
        pdfPageCache.delete(pageNumber);
        pdfPageCache.set(pageNumber, entry);
    }

    function rememberCachedPage(pageNumber: number, page: PDFPageProxy) {
        const existingEntry = pdfPageCache.get(pageNumber);
        const proxyEntry = pdfPageEntries.get(page);
        const entry = existingEntry?.page === page && !existingEntry.cleaned
            ? existingEntry
            : proxyEntry && !proxyEntry.cleaned
                ? proxyEntry
                : {
                    page,
                    pageNumber,
                    leases: 0,
                    pendingEviction: false,
                    cleaned: false,
                };
        entry.pageNumber = pageNumber;
        entry.pendingEviction = false;
        pdfPageEntries.set(page, entry);
        touchCachedPage(pageNumber, entry);
        enforcePageCacheLimit();
        return entry;
    }

    function enforcePageCacheLimit() {
        for (const oldestPageNumber of [...pdfPageCache.keys()]) {
            if (pdfPageCache.size <= maxCachedPdfPages) {
                break;
            }
            evictPage(oldestPageNumber);
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
        return loadState.value.version;
    }

    function incrementRenderVersion() {
        pageMetricLoads.clear();
        const version = loadState.value.version + 1;
        loadState.value = {
            ...loadState.value,
            version,
        };
        return version;
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
            /**
             * Keep metric-loaded page proxies in the bounded render cache.
             *
             * PDF.js may return the same `PDFPageProxy` for a later render.
             * Calling `cleanup()` after a metrics-only `getViewport()` looked
             * harmless, but on the scanned Girgas last page it left the
             * following canvas render waiting forever on PDF.js internals. The
             * cache already evicts old proxies, so ownership should stay there.
             */
            const page = await getPage(pageNumber);
            if (version !== getRenderVersion() || document !== pdfDocument.value) {
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

        const version = getRenderVersion();
        const concurrency = Math.min(4, pagesToLoad.length);
        let nextPageIndex = 0;

        await Promise.all(Array.from({ length: concurrency }, async () => {
            while (nextPageIndex < pagesToLoad.length) {
                const pageNumber = pagesToLoad[nextPageIndex]!;
                nextPageIndex += 1;
                if (version !== getRenderVersion()) {
                    return;
                }
                await loadPageMetric(document, pageNumber, version);
            }
        }));

        return version === getRenderVersion() && document === pdfDocument.value;
    }

    async function primeInitialPageMetrics(
        document: PDFDocumentProxy,
        version: number,
    ) {
        if (document.numPages <= 0) {
            resetLoadMetadata();
            return;
        }

        await loadPageMetric(document, 1, version);
        if (version !== getRenderVersion() || document !== pdfDocument.value) {
            return;
        }

        const firstMetric = pageMetrics.value[0];
        if (!isValidPageMetric(firstMetric)) {
            resetLoadMetadata();
            return;
        }

    }

    async function acceptLoadedDocument(
        document: PDFDocumentProxy,
        version: number,
    ) {
        // Discard stale result if a newer load was started
        if (version !== getRenderVersion()) {
            destroyPdfDocumentDeferred(document, 'Failed to destroy stale PDF document');
            return null;
        }

        loadState.value = {
            status: 'loading',
            version,
            document,
        };
        const leaseOwnedPage = (pageNumber: number) => {
            if (pdfDocument.value !== document) {
                throw createStalePdfDocumentError(
                    'Rendering cancelled: PDF page lease owner became stale',
                );
            }
            return leasePage(pageNumber);
        };
        pdfDocumentPageLeaseOwners.set(document, {leasePage: leaseOwnedPage});
        numPages.value = document.numPages;
        await primeInitialPageMetrics(document, version);
        if (version !== getRenderVersion() || document !== pdfDocument.value) {
            return null;
        }

        loadState.value = {
            status: 'ready',
            version,
            document,
        };

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
        loadState.value = {
            status: 'loading',
            version,
            document: null,
        };
        if (!shouldPreservePageStructure) {
            resetLoadMetadata();
        }

        return version;
    }

    function finishLoad(version: number) {
        // Only clear loading state if this is still the current load
        if (version === getRenderVersion() && loadState.value.status === 'loading') {
            loadState.value = {
                status: 'idle',
                version,
            };
        }
    }

    function handleLoadError(
        error: unknown,
        version: number,
    ) {
        // Ignore cancellation errors from destroyed loading tasks
        if (version !== getRenderVersion()) {
            return null;
        }
        BrowserLogger.error('pdf-document', 'Failed to load PDF', error);
        loadState.value = {
            status: 'failed',
            version,
            error,
        };
        return null;
    }

    function abortActiveRangeTransport(message: string) {
        if (!rangeTransport) {
            return;
        }

        try {
            rangeTransport.abort();
        } catch (error) {
            BrowserLogger.debug(
                'pdf-document',
                message,
                error,
            );
        } finally {
            rangeTransport = null;
        }
    }

    function destroyActiveLoadingTask(
        rejectedMessage: string,
        thrownMessage: string,
        thrownLogLevel: 'debug' | 'error' = 'debug',
    ) {
        if (!loadingTask) {
            return;
        }

        const task = loadingTask;
        loadingTask = null;
        try {
            guardAsync(task.destroy(), {
                category: 'background-diagnostic',
                scope: 'pdf-document',
                message: rejectedMessage,
                onError: (destroyError) => {
                    BrowserLogger.debug(
                        'pdf-document',
                        rejectedMessage,
                        destroyError,
                    );
                },
            });
        } catch (destroyError) {
            BrowserLogger[thrownLogLevel](
                'pdf-document',
                thrownMessage,
                destroyError,
            );
        }
    }

    function revokeActiveObjectUrl() {
        if (!objectUrl) {
            return;
        }

        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
    }

    function cleanupFailedLoadAttempt(version: number) {
        if (version !== getRenderVersion()) {
            return;
        }

        abortActiveRangeTransport('Failed to abort PDF range transport after load failure');
        destroyActiveLoadingTask(
            'PDF loading task destroy rejected after load failure',
            'Failed to destroy PDF loading task after load failure',
        );
        revokeActiveObjectUrl();
        clearAcceptedDocumentState();
    }

    function destroyLoadingTaskAfterRangeReadFailure() {
        destroyActiveLoadingTask(
            'PDF loading task destroy rejected after range read failure',
            'Failed to destroy PDF loading task after range read failure',
        );
    }

    function clearAcceptedDocumentState() {
        cleanupPageCache();
        pageMetricLoads.clear();
        const document = pdfDocument.value;
        if (document) {
            destroyPdfDocumentDeferred(document, 'Failed to destroy PDF document after load failure');
        }
        const state = loadState.value;
        if (state.status === 'loading') {
            loadState.value = {
                ...state,
                document: null,
            };
        } else if (state.status === 'ready') {
            loadState.value = {
                status: 'idle',
                version: state.version,
            };
        }
        numPages.value = 0;
        resetLoadMetadata();
    }

    function invalidateDocumentAfterRangeReadFailure(
        error: unknown,
        version: number,
    ) {
        if (version !== getRenderVersion()) {
            return;
        }

        if (!pdfDocument.value) {
            abortActiveRangeTransport('Failed to abort PDF range transport after range read failure');
            destroyLoadingTaskAfterRangeReadFailure();
            return;
        }

        const failedVersion = incrementRenderVersion();
        abortActiveRangeTransport('Failed to abort PDF range transport after range read failure');
        destroyLoadingTaskAfterRangeReadFailure();
        revokeActiveObjectUrl();
        clearAcceptedDocumentState();
        loadState.value = {
            status: 'failed',
            version: failedVersion,
            error,
        };
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

    /**
     * Fulfill the exact byte interval requested by PDF.js range transport.
     *
     * The platform read capability is chunk-budgeted and may legally return
     * fewer bytes than requested. PDF.js creates one range reader for the
     * original `[begin, end)` interval, so the bridge must aggregate any
     * subreads and call `onDataRange(begin, fullChunk)` exactly once. Delivering
     * only the first short chunk leaves the worker waiting forever; delivering
     * later chunks separately throws because there is no reader for their
     * shifted offset. The Girgas page 928 repro hit this when PDF.js requested
     * about 10 MB and Electron capped the read to 8 MB.
     */
    async function fulfillPdfRangeRequest(
        transport: PDFDataRangeTransport,
        src: Extract<TPdfSource, { kind: 'path' }>,
        begin: number,
        end: number,
        version: number,
        preloadedRanges: readonly IPdfPreloadedRange[],
    ) {
        const totalLength = end - begin;
        if (!Number.isSafeInteger(totalLength) || totalLength <= 0) {
            throw new Error(`Invalid PDF range request ${begin}..${end}`);
        }
        if (totalLength > MAX_AGGREGATE_PDF_RANGE_BYTES) {
            throw new Error(`PDF range request ${begin}..${end} exceeds ${MAX_AGGREGATE_PDF_RANGE_BYTES} byte limit`);
        }

        const preloadedRange = preloadedRanges.find((range) => {
            const relativeBegin = begin - range.begin;
            const relativeEnd = end - range.begin;
            return relativeBegin >= 0
                && relativeEnd <= range.data.byteLength;
        });
        if (preloadedRange) {
            const relativeBegin = begin - preloadedRange.begin;
            const relativeEnd = end - preloadedRange.begin;
            const output = preloadedRange.data.slice(relativeBegin, relativeEnd);
            transport.onDataRange(begin, output);
            logPdfRenderTrace('pdf-document-range-fulfilled-from-cache', {
                begin,
                end,
                byteLength: output.byteLength,
                version,
            });
            return;
        }

        const documentFiles = getDocumentFilesCapability();
        let cursor = begin;
        let outputOffset = 0;
        let output: Uint8Array | null = null;
        while (cursor < end) {
            if (version !== getRenderVersion()) {
                logPdfRenderTrace('pdf-document-range-request-stale-before-read', {
                    begin,
                    end,
                    cursor,
                    version,
                    renderVersion: getRenderVersion(),
                });
                return;
            }

            const requestedLength = Math.min(PDF_RANGE_SUBREAD_BYTES, end - cursor);
            const chunk = await documentFiles.readFileRange(src.path, cursor, requestedLength);
            if (version !== getRenderVersion()) {
                logPdfRenderTrace('pdf-document-range-request-stale-after-read', {
                    begin,
                    end,
                    cursor,
                    version,
                    renderVersion: getRenderVersion(),
                });
                return;
            }
            if (chunk.byteLength === 0) {
                throw new Error(`Range read returned no bytes at ${cursor} before requested end ${end}`);
            }

            if (cursor === begin && chunk.byteLength === totalLength) {
                transport.onDataRange(begin, chunk);
                logPdfRenderTrace('pdf-document-range-fulfilled-direct', {
                    begin,
                    end,
                    byteLength: chunk.byteLength,
                    version,
                });
                return;
            }

            output ??= new Uint8Array(totalLength);
            if (chunk.byteLength > output.byteLength - outputOffset) {
                throw new Error(`Range read returned ${chunk.byteLength} bytes for ${output.byteLength - outputOffset} remaining bytes`);
            }

            output.set(chunk, outputOffset);
            logPdfRenderTrace('pdf-document-range-subread', {
                begin: cursor,
                end: cursor + chunk.byteLength,
                requestedEnd: end,
                byteLength: chunk.byteLength,
                requestedLength,
                version,
            });
            outputOffset += chunk.byteLength;
            cursor += chunk.byteLength;
        }

        if (!output) {
            throw new Error(`Range read produced no output for ${begin}..${end}`);
        }
        transport.onDataRange(begin, output);
        logPdfRenderTrace('pdf-document-range-fulfilled', {
            begin,
            end,
            byteLength: output.byteLength,
            version,
        });
    }

    function attachRangeRequestHandler(
        transport: PDFDataRangeTransport,
        src: Extract<TPdfSource, { kind: 'path' }>,
        version: number,
        failRangeRead: (error: unknown) => void,
        preloadedRanges: readonly IPdfPreloadedRange[],
    ) {
        // PDF.js will call this to request additional chunks.
        transport.requestDataRange = (
            begin,
            end: number,
        ) => {
            void (async () => {
                logPdfRenderTrace('pdf-document-range-request', {
                    begin,
                    end,
                    length: end - begin,
                    version,
                });
                try {
                    await fulfillPdfRangeRequest(
                        transport,
                        src,
                        begin,
                        end,
                        version,
                        preloadedRanges,
                    );
                } catch (error) {
                    if (version !== getRenderVersion()) {
                        return;
                    }

                    logPdfRenderTrace('pdf-document-range-error', {
                        begin,
                        end,
                        version,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    BrowserLogger.error(
                        'pdf-document',
                        'Failed to read PDF range chunk',
                        error,
                    );
                    failRangeRead(error);
                    invalidateDocumentAfterRangeReadFailure(error, version);
                }
            })();
        };
    }

    async function loadPdfFromBlob(
        src: Blob,
        version: number,
    ) {
        if (version !== getRenderVersion()) {
            return null;
        }

        const documentOptions = await getPdfjsDocumentOptions();
        if (version !== getRenderVersion()) {
            return null;
        }

        objectUrl = URL.createObjectURL(src);
        loadingTask = pdfjsLib.getDocument({
            url: objectUrl,
            ...documentOptions,
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
        if (shouldUseNativePdfPreview(src)) {
            throw new Error(
                `PDF is ${length} bytes; PDF.js is capped at ${PDFJS_NATIVE_PREVIEW_MIN_BYTES} bytes for path-backed documents. Native preview should handle this file.`,
            );
        }
        const CHUNK = 1024 * 1024;
        const initialLen = Math.min(CHUNK, length);

        // Read the head (PDF header/catalog) and tail (xref/trailer)
        // in parallel so both are available before getDocument starts.
        const tailStart = Math.max(initialLen, length - CHUNK);
        const needsTail = tailStart > initialLen;
        const documentFiles = getDocumentFilesCapability();
        const [
            initialData,
            tailData,
        ] = await Promise.all([
            documentFiles.readFileRange(src.path, 0, initialLen),
            needsTail
                ? documentFiles.readFileRange(src.path, tailStart, length - tailStart)
                : Promise.resolve(null),
        ]);

        if (version !== getRenderVersion()) {
            return null;
        }

        const documentOptions = await getPdfjsDocumentOptions();
        if (version !== getRenderVersion()) {
            return null;
        }

        const pdfjsWithRangeTransport = pdfjsLib as typeof pdfjsLib & {PDFDataRangeTransport?: TPdfDataRangeTransportCtor;};
        const TransportCtor = 'PDFDataRangeTransport' in pdfjsWithRangeTransport
            ? pdfjsWithRangeTransport.PDFDataRangeTransport
            : undefined;
        if (!TransportCtor) {
            throw new Error('PDF.js range transport API is unavailable');
        }

        rangeTransport = new TransportCtor(
            length,
            initialData,
            false,
        );
        const activeRangeTransport = rangeTransport;
        const preloadedRanges: IPdfPreloadedRange[] = tailData
            ? [{
                begin: tailStart,
                data: tailData,
            }]
            : [];

        const rangeFailure = createRangeReadFailureHandler();
        attachRangeRequestHandler(
            activeRangeTransport,
            src,
            version,
            rangeFailure.failRangeRead,
            preloadedRanges,
        );

        loadingTask = pdfjsLib.getDocument({
            range: activeRangeTransport,
            length,
            rangeChunkSize: 1024 * 1024,
            disableAutoFetch: true,
            disableStream: true,
            ...documentOptions,
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
            cleanupFailedLoadAttempt(version);
            return handleLoadError(error, version);
        } finally {
            finishLoad(version);
        }
    }

    async function getPage(pageNumber: number) {
        const document = pdfDocument.value;
        const version = getRenderVersion();

        if (!document) {
            throw new Error('No PDF document loaded');
        }

        const entry = pdfPageCache.get(pageNumber);
        let page = entry?.page;
        if (!page) {
            logPdfRenderTrace('pdf-document-page-cache-miss', {
                pageNumber,
                version,
                renderVersion: getRenderVersion(),
            });
            page = await document.getPage(pageNumber);
            if (version !== getRenderVersion() || document !== pdfDocument.value) {
                logPdfRenderTrace('pdf-document-page-cache-stale-cleanup', {
                    pageNumber,
                    version,
                    renderVersion: getRenderVersion(),
                });
                page.cleanup();
                throw createStalePdfDocumentError(
                    'Rendering cancelled: PDF page request became stale',
                );
            }
            rememberCachedPage(pageNumber, page);
            logPdfRenderTrace('pdf-document-page-cache-store', {
                pageNumber,
                cacheSize: pdfPageCache.size,
            });
        } else {
            logPdfRenderTrace('pdf-document-page-cache-hit', {
                pageNumber,
                cacheSize: pdfPageCache.size,
                leases: entry?.leases ?? 0,
                pendingEviction: entry?.pendingEviction ?? false,
            });
            if (entry) {
                touchCachedPage(pageNumber, entry);
            }
        }
        return page;
    }

    async function leasePage(pageNumber: number) {
        const page = await getPage(pageNumber);
        const entry = pdfPageCache.get(pageNumber);
        if (!entry || entry.page !== page) {
            throw createStalePdfDocumentError(
                'Rendering cancelled: PDF page lease became stale',
            );
        }
        entry.leases += 1;
        logPdfRenderTrace('pdf-document-page-lease-acquire', {
            pageNumber,
            leases: entry.leases,
            renderVersion: getRenderVersion(),
        });
        let released = false;
        return {
            page,
            release: () => {
                if (released) {
                    return;
                }
                released = true;
                releasePageEntry(entry);
            },
        } satisfies IPdfDocumentPageLease;
    }

    function cleanupPageEntry(pageNumber: number, entry: IPdfCachedPageEntry) {
        if (entry.cleaned) {
            return;
        }
        entry.cleaned = true;
        logPdfRenderTrace('pdf-document-page-cache-cleanup-page', {
            pageNumber,
            leases: entry.leases,
            pendingEviction: entry.pendingEviction,
            renderVersion: getRenderVersion(),
        });
        entry.page.cleanup();
    }

    function deferPageEntryEviction(pageNumber: number, entry: IPdfCachedPageEntry) {
        entry.pendingEviction = true;
        if (pdfPageCache.get(pageNumber) === entry) {
            pdfPageCache.delete(pageNumber);
        }
    }

    function releasePageEntry(entry: IPdfCachedPageEntry) {
        entry.leases = Math.max(0, entry.leases - 1);
        logPdfRenderTrace('pdf-document-page-lease-release', {
            pageNumber: entry.pageNumber,
            leases: entry.leases,
            pendingEviction: entry.pendingEviction,
            renderVersion: getRenderVersion(),
        });
        if (entry.leases === 0 && entry.pendingEviction) {
            cleanupPageEntry(entry.pageNumber, entry);
            if (pdfPageCache.get(entry.pageNumber) === entry) {
                pdfPageCache.delete(entry.pageNumber);
            }
        }
    }

    function evictPage(pageNumber: number) {
        const entry = pdfPageCache.get(pageNumber);
        if (!entry) {
            return;
        }

        logPdfRenderTrace('pdf-document-page-cache-evict', {
            pageNumber,
            cacheSize: pdfPageCache.size,
            leases: entry.leases,
        });
        if (entry.leases > 0) {
            deferPageEntryEviction(pageNumber, entry);
            return;
        }
        cleanupPageEntry(pageNumber, entry);
        pdfPageCache.delete(pageNumber);
    }

    function cleanupPageCache() {
        logPdfRenderTrace('pdf-document-page-cache-cleanup-all', {
            pageCount: pdfPageCache.size,
            pages: Array.from(pdfPageCache.keys()).slice(0, 40),
        });
        for (const [
            pageNumber,
            entry,
        ] of pdfPageCache) {
            if (entry.leases > 0) {
                deferPageEntryEviction(pageNumber, entry);
                continue;
            }
            cleanupPageEntry(pageNumber, entry);
            pdfPageCache.delete(pageNumber);
        }
    }

    function cleanup() {
        const version = incrementRenderVersion();
        const document = pdfDocument.value;
        cleanupPageCache();
        pageMetricLoads.clear();
        abortActiveRangeTransport('Failed to abort PDF range transport');

        destroyActiveLoadingTask(
            'PDF loading task destroy rejected',
            'Failed to destroy PDF loading task',
            'error',
        );

        if (document) {
            destroyPdfDocumentDeferred(document, 'Failed to destroy PDF document');
        }

        revokeActiveObjectUrl();

        numPages.value = 0;
        basePageWidth.value = null;
        basePageHeight.value = null;
        pageMetrics.value = [];
        bumpPageMetricsVersion();
        loadState.value = {
            status: 'idle',
            version,
        };
    }

    return {
        loadState,
        pdfDocument,
        numPages,
        isLoading,
        basePageWidth,
        basePageHeight,
        pageMetrics,
        pageMetricsVersion,
        loadError,
        getRenderVersion,
        incrementRenderVersion,
        loadPdf,
        ensurePageMetricsInRange,
        getPage,
        leasePage,
        evictPage,
        cleanupPageCache,
        cleanup,
    };
};
