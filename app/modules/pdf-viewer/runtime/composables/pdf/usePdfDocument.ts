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
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { maxCachedPdfPages } from '@app/modules/pdf-viewer/engine/maxCachedPdfPages';
import {
    PDFJS_NATIVE_PREVIEW_MIN_BYTES,
    shouldUseNativePdfPreview,
} from '@app/modules/pdf-viewer/runtime/pdfNativePreviewRouting';
import { buildTrustedPdfGeometrySeed } from '@app/modules/pdf-viewer/runtime/lifecycle/buildTrustedPdfGeometrySeed';
import { pdfjsDocumentTeardownCoordinator } from '@app/modules/pdf-viewer/runtime/composables/pdf/pdfjsDocumentTeardownCoordinator';
import {
    createPdfRangeRequestBridge,
    type IPdfPreloadedRange,
} from '@app/modules/pdf-viewer/runtime/composables/pdf/createPdfRangeRequestBridge';

configurePdfjsWorkerSrc(pdfjsLib);

type TPdfDataRangeTransportCtor = new (
    length: number,
    initialData: Uint8Array,
    progressiveDone?: boolean,
) => PDFDataRangeTransport;

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
        source: TPdfSource | null;
    };
    ready: {
        version: number;
        document: PDFDocumentProxy;
        source: TPdfSource;
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

export type TPdfDocumentPageLeaseRetention = 'render-cache' | 'transient-background';

interface IPdfDocumentPageLeaseOwner {leasePage: (
    pageNumber: number,
    retention?: TPdfDocumentPageLeaseRetention,
) => Promise<IPdfDocumentPageLease>;}

const pdfDocumentPageLeaseOwners = new WeakMap<PDFDocumentProxy, IPdfDocumentPageLeaseOwner>();
const PDFJS_MAX_SUPPORTED_PAGE_COUNT = 100_000;

export async function leasePdfDocumentPage(
    document: PDFDocumentProxy,
    pageNumber: number,
    retention: TPdfDocumentPageLeaseRetention = 'render-cache',
) {
    const owner = pdfDocumentPageLeaseOwners.get(document);
    if (!owner) {
        throw new Error('PDF document page lease owner is unavailable');
    }
    return owner.leasePage(pageNumber, retention);
}

function createStalePdfDocumentError(message: string) {
    const error = new Error(message);
    error.name = 'RenderingCancelledException';
    return error;
}

function normalizePdfDocumentLifecycleKey(value: string | undefined, fallback: string) {
    const normalized = value?.trim();
    if (!normalized) {
        return fallback;
    }
    return normalized;
}

export const usePdfDocument = () => {
    const fallbackLifecycleKey = `pdf-viewer:${crypto.randomUUID()}`;
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
    const acceptedSource = computed<TPdfSource | null>(() => {
        const state = loadState.value;
        return (state.status === 'loading' || state.status === 'ready')
            && state.document
            ? state.source
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
    let activeLifecycleKey = fallbackLifecycleKey;
    let loadingTaskLifecycleKey = fallbackLifecycleKey;
    let teardownWaitAbortController: AbortController | null = null;
    let trustedGeometrySeedPending = false;
    let trustedGeometrySeedPageNumber: number | null = null;

    function destroyPdfDocument(
        document: PDFDocumentProxy,
        message: string,
        lifecycleKey = activeLifecycleKey,
    ) {
        pdfjsDocumentTeardownCoordinator.track(lifecycleKey, {
            message,
            run: () => document.destroy(),
        });
    }

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

    function seedTrustedPageGeometry(input: {
        pageNumber: number;
        pageCount: number;
        width: number;
        height: number;
        rotation?: number;
    }) {
        const seed = buildTrustedPdfGeometrySeed(input);
        if (!seed) {
            return false;
        }
        numPages.value = seed.numPages;
        basePageWidth.value = seed.basePageWidth;
        basePageHeight.value = seed.basePageHeight;
        pageMetrics.value = seed.pageMetrics;
        trustedGeometrySeedPending = true;
        trustedGeometrySeedPageNumber = input.pageNumber;
        bumpPageMetricsVersion();
        return true;
    }

    function hasExactPageGeometry(pageNumber: number) {
        return isValidPageMetric(pageMetrics.value[pageNumber - 1])
            || trustedGeometrySeedPageNumber === pageNumber;
    }

    function updateBaseMetrics(metric: IPdfPageMetric) {
        basePageWidth.value = Math.max(basePageWidth.value ?? 0, metric.width);
        basePageHeight.value = Math.max(basePageHeight.value ?? 0, metric.height);
    }

    function replaceTrustedBaseMetrics() {
        let width = 0;
        let height = 0;
        for (const metric of pageMetrics.value) {
            if (!isValidPageMetric(metric)) {
                continue;
            }
            width = Math.max(width, metric.width);
            height = Math.max(height, metric.height);
        }
        basePageWidth.value = width > 0 ? width : null;
        basePageHeight.value = height > 0 ? height : null;
        trustedGeometrySeedPageNumber = null;
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
                rotation: viewport.rotation,
                userUnit: viewport.userUnit,
            } satisfies IPdfPageMetric;
            if (!isValidPageMetric(metric)) {
                return null;
            }

            pageMetrics.value[pageNumber - 1] = metric;
            if (trustedGeometrySeedPageNumber === pageNumber) {
                // Native opening geometry is a shell seed, not a permanent
                // document maximum. Once PDF.js measures that exact page,
                // rebuild the fallback baseline from authoritative metrics so
                // a larger provisional box cannot remain sticky.
                replaceTrustedBaseMetrics();
            } else {
                updateBaseMetrics(metric);
            }
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
        lifecycleKey: string,
        source: TPdfSource,
    ) {
        // Discard stale result if a newer load was started
        if (version !== getRenderVersion()) {
            destroyPdfDocument(document, 'Failed to destroy stale PDF document', lifecycleKey);
            return null;
        }
        if (
            !Number.isSafeInteger(document.numPages)
            || document.numPages < 1
            || document.numPages > PDFJS_MAX_SUPPORTED_PAGE_COUNT
        ) {
            destroyPdfDocument(document, 'Failed to destroy PDF document after page-count rejection', lifecycleKey);
            throw new RangeError(`PDF.js viewer supports at most ${PDFJS_MAX_SUPPORTED_PAGE_COUNT.toLocaleString()} pages`);
        }

        activeLifecycleKey = lifecycleKey;
        loadState.value = {
            status: 'loading',
            version,
            document,
            source,
        };
        const leaseOwnedPage = (
            pageNumber: number,
            retention: TPdfDocumentPageLeaseRetention = 'render-cache',
        ) => {
            if (pdfDocument.value !== document) {
                throw createStalePdfDocumentError(
                    'Rendering cancelled: PDF page lease owner became stale',
                );
            }
            return retention === 'transient-background'
                ? leaseTransientBackgroundPage(pageNumber)
                : leasePage(pageNumber);
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
            source,
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
            trustedGeometrySeedPageNumber: shouldPreserve
                ? trustedGeometrySeedPageNumber
                : null,
        };
    }

    function restorePreservedLoadState(
        state: ReturnType<typeof preserveLoadState>,
    ) {
        numPages.value = state.numPages;
        basePageWidth.value = state.basePageWidth;
        basePageHeight.value = state.basePageHeight;
        pageMetrics.value = state.pageMetrics;
        trustedGeometrySeedPageNumber = state.trustedGeometrySeedPageNumber;
        bumpPageMetricsVersion();
    }

    function resetLoadMetadata() {
        basePageWidth.value = null;
        basePageHeight.value = null;
        pageMetrics.value = [];
        trustedGeometrySeedPageNumber = null;
        bumpPageMetricsVersion();
    }

    function startLoad(
        options: { preservePageStructure?: boolean } | undefined,
    ) {
        const shouldPreservePageStructure = options?.preservePageStructure === true
            || trustedGeometrySeedPending;
        const savedState = preserveLoadState(shouldPreservePageStructure);
        trustedGeometrySeedPending = false;

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
            source: null,
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
        pdfjsDocumentTeardownCoordinator.track(loadingTaskLifecycleKey, {
            message: rejectedMessage,
            run: async () => {
                try {
                    await task.destroy();
                } catch (destroyError) {
                    BrowserLogger[thrownLogLevel](
                        'pdf-document',
                        thrownMessage,
                        destroyError,
                    );
                }
            },
        });
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
            destroyPdfDocument(document, 'Failed to destroy PDF document after load failure');
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

    const {
        createRangeReadFailureHandler,
        attachRangeRequestHandler,
    } = createPdfRangeRequestBridge({
        getRenderVersion,
        onRangeReadFailure: invalidateDocumentAfterRangeReadFailure,
    });

    async function loadPdfFromBlob(
        src: Blob,
        version: number,
        lifecycleKey: string,
    ) {
        if (src.size >= PDFJS_NATIVE_PREVIEW_MIN_BYTES) {
            throw new RangeError(
                `Blob-backed PDF is ${src.size} bytes; PDF.js blob loading is capped at ${PDFJS_NATIVE_PREVIEW_MIN_BYTES} bytes`,
            );
        }
        if (version !== getRenderVersion()) {
            return null;
        }

        const optionsStartedAt = performance.now();
        logPdfRenderTrace('pdf-document-options-start', {
            version,
            sourceKind: 'blob',
            declaredSize: src.size,
        });
        const documentOptions = await getPdfjsDocumentOptions();
        logPdfRenderTrace('pdf-document-options-end', {
            version,
            sourceKind: 'blob',
            elapsedMs: performance.now() - optionsStartedAt,
        });
        if (version !== getRenderVersion()) {
            return null;
        }

        objectUrl = URL.createObjectURL(src);
        const getDocumentStartedAt = performance.now();
        logPdfRenderTrace('pdf-document-get-document-submit', {
            version,
            sourceKind: 'blob',
            declaredSize: src.size,
        });
        loadingTask = pdfjsLib.getDocument({
            url: objectUrl,
            ...documentOptions,
        });

        const activeLoadingTask = loadingTask;
        const pdfDoc = await activeLoadingTask.promise;
        if (loadingTask === activeLoadingTask) {
            loadingTask = null;
        }
        logPdfRenderTrace('pdf-document-get-document-resolve', {
            version,
            sourceKind: 'blob',
            declaredSize: src.size,
            numPages: pdfDoc.numPages,
            elapsedMs: performance.now() - getDocumentStartedAt,
        });
        return acceptLoadedDocument(pdfDoc, version, lifecycleKey, src);
    }

    async function loadPdfFromPath(
        src: Extract<TPdfSource, { kind: 'path' }>,
        version: number,
        lifecycleKey: string,
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
        const preloadStartedAt = performance.now();
        logPdfRenderTrace('pdf-document-range-preload-start', {
            version,
            sourceKind: 'path',
            path: src.path,
            declaredSize: length,
        });
        const [
            initialData,
            tailData,
        ] = await Promise.all([
            documentFiles.readFileRange(src.path, 0, initialLen),
            needsTail
                ? documentFiles.readFileRange(src.path, tailStart, length - tailStart)
                : Promise.resolve(null),
        ]);
        logPdfRenderTrace('pdf-document-range-preload-end', {
            version,
            sourceKind: 'path',
            path: src.path,
            declaredSize: length,
            bytesRead: initialData.byteLength + (tailData?.byteLength ?? 0),
            elapsedMs: performance.now() - preloadStartedAt,
        });

        if (version !== getRenderVersion()) {
            return null;
        }

        const optionsStartedAt = performance.now();
        logPdfRenderTrace('pdf-document-options-start', {
            version,
            sourceKind: 'path',
            path: src.path,
            declaredSize: length,
        });
        const documentOptions = await getPdfjsDocumentOptions();
        logPdfRenderTrace('pdf-document-options-end', {
            version,
            sourceKind: 'path',
            path: src.path,
            elapsedMs: performance.now() - optionsStartedAt,
        });
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
            rangeFailure,
            preloadedRanges,
        );

        const getDocumentStartedAt = performance.now();
        logPdfRenderTrace('pdf-document-get-document-submit', {
            version,
            sourceKind: 'path',
            path: src.path,
            declaredSize: length,
        });
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
        if (loadingTask === activeLoadingTask) {
            loadingTask = null;
        }
        rangeFailure.complete();
        logPdfRenderTrace('pdf-document-get-document-resolve', {
            version,
            sourceKind: 'path',
            path: src.path,
            declaredSize: length,
            numPages: pdfDoc.numPages,
            elapsedMs: performance.now() - getDocumentStartedAt,
        });

        return acceptLoadedDocument(pdfDoc, version, lifecycleKey, src);
    }

    async function loadPdf(
        src: TPdfSource,
        options?: {
            lifecycleKey?: string;
            preservePageStructure?: boolean;
        },
    ) {
        const version = startLoad(options);
        const lifecycleKey = normalizePdfDocumentLifecycleKey(
            options?.lifecycleKey,
            fallbackLifecycleKey,
        );
        const waitAbortController = new AbortController();
        teardownWaitAbortController = waitAbortController;

        try {
            await pdfjsDocumentTeardownCoordinator.waitForIdle(
                lifecycleKey,
                waitAbortController.signal,
            );
            if (version !== getRenderVersion()) {
                return null;
            }
            loadingTaskLifecycleKey = lifecycleKey;
            if (src instanceof Blob) {
                return await loadPdfFromBlob(src, version, lifecycleKey);
            }

            return await loadPdfFromPath(src, version, lifecycleKey);
        } catch (error) {
            cleanupFailedLoadAttempt(version);
            return handleLoadError(error, version);
        } finally {
            if (teardownWaitAbortController === waitAbortController) {
                teardownWaitAbortController = null;
            }
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

    async function leaseTransientBackgroundPage(pageNumber: number) {
        const document = pdfDocument.value;
        const version = getRenderVersion();
        if (!document) {
            throw new Error('No PDF document loaded');
        }

        const cached = pdfPageCache.get(pageNumber);
        if (cached && !cached.cleaned) {
            return leasePage(pageNumber);
        }

        const page = await document.getPage(pageNumber);
        if (version !== getRenderVersion() || document !== pdfDocument.value) {
            throw createStalePdfDocumentError(
                'Background PDF page request became stale',
            );
        }

        // A visible render may have claimed the same PDF.js proxy while the
        // background request was in flight. Join that owner instead of
        // cleaning a page which is about to paint.
        const claimed = pdfPageEntries.get(page);
        if (claimed && !claimed.cleaned) {
            claimed.leases += 1;
            return {
                page,
                release: () => releasePageEntry(claimed),
            } satisfies IPdfDocumentPageLease;
        }

        let released = false;
        return {
            page,
            release: () => {
                if (released) {
                    return;
                }
                released = true;
                // Do not call PDFPageProxy.cleanup() here. PDF.js returns the
                // same proxy to a later visible render, and cleaning a
                // metrics/annotation-only proxy has caused scanned-page
                // renders to stall. The PDFDocumentProxy remains the owner
                // and releases these transient proxies on destroy.
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
        teardownWaitAbortController?.abort();
        teardownWaitAbortController = null;
        const version = incrementRenderVersion();
        const document = pdfDocument.value;
        cleanupPageCache();
        pageMetricLoads.clear();
        abortActiveRangeTransport('Failed to abort PDF range transport');

        if (document) {
            loadingTask = null;
            destroyPdfDocument(document, 'Failed to destroy PDF document');
        } else {
            destroyActiveLoadingTask(
                'PDF loading task destroy rejected',
                'Failed to destroy PDF loading task',
                'error',
            );
        }

        revokeActiveObjectUrl();

        numPages.value = 0;
        basePageWidth.value = null;
        basePageHeight.value = null;
        pageMetrics.value = [];
        trustedGeometrySeedPageNumber = null;
        bumpPageMetricsVersion();
        loadState.value = {
            status: 'idle',
            version,
        };
    }

    return {
        loadState,
        pdfDocument,
        acceptedSource,
        numPages,
        isLoading,
        basePageWidth,
        basePageHeight,
        pageMetrics,
        pageMetricsVersion,
        hasExactPageGeometry,
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
        seedTrustedPageGeometry,
    };
};
