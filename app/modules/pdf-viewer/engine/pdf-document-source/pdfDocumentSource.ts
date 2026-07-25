import type {
    PDFDataRangeTransport,
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
import pdfjsLib, {
    configurePdfjsWorkerSrc,
    createPdfjsDocumentOptions,
    preparePdfjsBrowserRuntime,
} from '@app/services/pdfjs/runtimeLib';
import type { TPdfSource } from '@app/types/pdfUi';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { maxCachedPdfPages } from '@app/modules/pdf-viewer/engine/maxCachedPdfPages';
import {
    PDFJS_NATIVE_PREVIEW_MIN_BYTES,
    shouldUseNativePdfPreview,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfNativePreviewRouting';
import { pdfjsDocumentTeardownCoordinator } from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfjsDocumentTeardownCoordinator';
import {
    createPdfRangeRequestBridge,
    type IPdfPreloadedRange,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/createPdfRangeRequestBridge';
import type {
    IPdfDocumentPageLease,
    TPdfDocumentPageLeaseRetention,
} from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';

interface IPdfCachedPageEntry {
    page: PDFPageProxy;
    pageNumber: number;
    leases: number;
    pendingEviction: boolean;
    cleaned: boolean;
}

interface ICreatePdfDocumentPageCacheOptions {
    getDocument: () => PDFDocumentProxy | null;
    getRenderVersion: () => number;
}

export function createStalePdfDocumentError(message: string) {
    const error = new Error(message);
    error.name = 'RenderingCancelledException';
    return error;
}

/**
 * Bounded owner of live `PDFPageProxy` handles for one document session.
 *
 * Leases keep a proxy alive across an in-flight PDF.js render; eviction is
 * deferred until the last lease releases, which is what preserves the
 * settle-before-release invariant shared with `runCoordinatedPdfPageRender`.
 */
export function createPdfDocumentPageCache(options: ICreatePdfDocumentPageCacheOptions) {
    const entriesByPageNumber = new Map<number, IPdfCachedPageEntry>();
    const entriesByProxy = new WeakMap<PDFPageProxy, IPdfCachedPageEntry>();

    function touch(pageNumber: number, entry: IPdfCachedPageEntry) {
        entriesByPageNumber.delete(pageNumber);
        entriesByPageNumber.set(pageNumber, entry);
    }

    function cleanupEntry(pageNumber: number, entry: IPdfCachedPageEntry) {
        if (entry.cleaned) {
            return;
        }
        entry.cleaned = true;
        logPdfRenderTrace('pdf-document-page-cache-cleanup-page', {
            pageNumber,
            leases: entry.leases,
            pendingEviction: entry.pendingEviction,
            renderVersion: options.getRenderVersion(),
        });
        entry.page.cleanup();
    }

    function deferEviction(pageNumber: number, entry: IPdfCachedPageEntry) {
        entry.pendingEviction = true;
        if (entriesByPageNumber.get(pageNumber) === entry) {
            entriesByPageNumber.delete(pageNumber);
        }
    }

    function releaseEntry(entry: IPdfCachedPageEntry) {
        entry.leases = Math.max(0, entry.leases - 1);
        logPdfRenderTrace('pdf-document-page-lease-release', {
            pageNumber: entry.pageNumber,
            leases: entry.leases,
            pendingEviction: entry.pendingEviction,
            renderVersion: options.getRenderVersion(),
        });
        if (entry.leases === 0 && entry.pendingEviction) {
            cleanupEntry(entry.pageNumber, entry);
            if (entriesByPageNumber.get(entry.pageNumber) === entry) {
                entriesByPageNumber.delete(entry.pageNumber);
            }
        }
    }

    function evictPage(pageNumber: number) {
        const entry = entriesByPageNumber.get(pageNumber);
        if (!entry) {
            return;
        }
        logPdfRenderTrace('pdf-document-page-cache-evict', {
            pageNumber,
            cacheSize: entriesByPageNumber.size,
            leases: entry.leases,
        });
        if (entry.leases > 0) {
            deferEviction(pageNumber, entry);
            return;
        }
        cleanupEntry(pageNumber, entry);
        entriesByPageNumber.delete(pageNumber);
    }

    function enforceLimit() {
        for (const oldestPageNumber of [...entriesByPageNumber.keys()]) {
            if (entriesByPageNumber.size <= maxCachedPdfPages) {
                break;
            }
            evictPage(oldestPageNumber);
        }
    }

    function remember(pageNumber: number, page: PDFPageProxy) {
        const existingEntry = entriesByPageNumber.get(pageNumber);
        const proxyEntry = entriesByProxy.get(page);
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
        entriesByProxy.set(page, entry);
        touch(pageNumber, entry);
        enforceLimit();
        return entry;
    }

    async function getPage(pageNumber: number) {
        const document = options.getDocument();
        const version = options.getRenderVersion();

        if (!document) {
            throw new Error('No PDF document loaded');
        }

        const entry = entriesByPageNumber.get(pageNumber);
        let page = entry?.page;
        if (!page) {
            logPdfRenderTrace('pdf-document-page-cache-miss', {
                pageNumber,
                version,
                renderVersion: options.getRenderVersion(),
            });
            page = await document.getPage(pageNumber);
            if (version !== options.getRenderVersion() || document !== options.getDocument()) {
                logPdfRenderTrace('pdf-document-page-cache-stale-cleanup', {
                    pageNumber,
                    version,
                    renderVersion: options.getRenderVersion(),
                });
                page.cleanup();
                throw createStalePdfDocumentError(
                    'Rendering cancelled: PDF page request became stale',
                );
            }
            remember(pageNumber, page);
            logPdfRenderTrace('pdf-document-page-cache-store', {
                pageNumber,
                cacheSize: entriesByPageNumber.size,
            });
        } else {
            logPdfRenderTrace('pdf-document-page-cache-hit', {
                pageNumber,
                cacheSize: entriesByPageNumber.size,
                leases: entry?.leases ?? 0,
                pendingEviction: entry?.pendingEviction ?? false,
            });
            if (entry) {
                touch(pageNumber, entry);
            }
        }
        return page;
    }

    async function leasePage(pageNumber: number): Promise<IPdfDocumentPageLease> {
        const page = await getPage(pageNumber);
        const entry = entriesByPageNumber.get(pageNumber);
        if (!entry || entry.page !== page) {
            throw createStalePdfDocumentError(
                'Rendering cancelled: PDF page lease became stale',
            );
        }
        entry.leases += 1;
        logPdfRenderTrace('pdf-document-page-lease-acquire', {
            pageNumber,
            leases: entry.leases,
            renderVersion: options.getRenderVersion(),
        });
        let released = false;
        return {
            page,
            release: () => {
                if (released) {
                    return;
                }
                released = true;
                releaseEntry(entry);
            },
        };
    }

    async function leaseTransientBackgroundPage(pageNumber: number): Promise<IPdfDocumentPageLease> {
        const document = options.getDocument();
        const version = options.getRenderVersion();
        if (!document) {
            throw new Error('No PDF document loaded');
        }

        const cached = entriesByPageNumber.get(pageNumber);
        if (cached && !cached.cleaned) {
            return leasePage(pageNumber);
        }

        const page = await document.getPage(pageNumber);
        if (version !== options.getRenderVersion() || document !== options.getDocument()) {
            throw createStalePdfDocumentError('Background PDF page request became stale');
        }

        // A visible render may have claimed the same PDF.js proxy while the
        // background request was in flight. Join that owner instead of
        // cleaning a page which is about to paint.
        const claimed = entriesByProxy.get(page);
        if (claimed && !claimed.cleaned) {
            claimed.leases += 1;
            return {
                page,
                release: () => releaseEntry(claimed),
            };
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
        };
    }

    function cleanupAll() {
        logPdfRenderTrace('pdf-document-page-cache-cleanup-all', {
            pageCount: entriesByPageNumber.size,
            pages: Array.from(entriesByPageNumber.keys()).slice(0, 40),
        });
        for (const [
            pageNumber,
            entry,
        ] of entriesByPageNumber) {
            if (entry.leases > 0) {
                deferEviction(pageNumber, entry);
                continue;
            }
            cleanupEntry(pageNumber, entry);
            entriesByPageNumber.delete(pageNumber);
        }
    }

    return {
        getPage,
        leasePage,
        leaseTransientBackgroundPage,
        evictPage,
        cleanupAll,
    };
}

configurePdfjsWorkerSrc(pdfjsLib);

type TPdfDataRangeTransportCtor = new (
    length: number,
    initialData: Uint8Array,
    progressiveDone?: boolean,
) => PDFDataRangeTransport;

const RANGE_CHUNK_BYTES = 1024 * 1024;

interface ICreatePdfjsDocumentSourceLoaderOptions {
    getRenderVersion: () => number;
    onRangeReadFailure: (error: unknown, version: number) => void;
}

/** Owns the PDF.js loading task, range transport, and object URL for a document session. */
export function createPdfjsDocumentSourceLoader(options: ICreatePdfjsDocumentSourceLoaderOptions) {
    let objectUrl: string | null = null;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    let rangeTransport: PDFDataRangeTransport | null = null;
    let loadingTaskLifecycleKey = '';
    const {
        createRangeReadFailureHandler,
        attachRangeRequestHandler,
    } = createPdfRangeRequestBridge({
        getRenderVersion: options.getRenderVersion,
        onRangeReadFailure: options.onRangeReadFailure,
    });

    async function getPdfjsDocumentOptions() {
        await preparePdfjsBrowserRuntime(pdfjsLib);
        return createPdfjsDocumentOptions(pdfjsLib);
    }

    function abortTransport(message: string) {
        if (!rangeTransport) {
            return;
        }
        try {
            rangeTransport.abort();
        } catch (error) {
            BrowserLogger.debug('pdf-document', message, error);
        } finally {
            rangeTransport = null;
        }
    }

    function destroyLoadingTask(
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
                } catch (error) {
                    BrowserLogger[thrownLogLevel]('pdf-document', thrownMessage, error);
                }
            },
        });
    }

    function revokeObjectUrl() {
        if (!objectUrl) {
            return;
        }
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
    }

    async function openBlob(src: Blob, version: number) {
        if (src.size >= PDFJS_NATIVE_PREVIEW_MIN_BYTES) {
            throw new RangeError(
                `Blob-backed PDF is ${src.size} bytes; PDF.js blob loading is capped at ${PDFJS_NATIVE_PREVIEW_MIN_BYTES} bytes`,
            );
        }
        if (version !== options.getRenderVersion()) {
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
        if (version !== options.getRenderVersion()) {
            return null;
        }
        objectUrl = URL.createObjectURL(src);
        const startedAt = performance.now();
        logPdfRenderTrace('pdf-document-get-document-submit', {
            version,
            sourceKind: 'blob',
            declaredSize: src.size,
        });
        loadingTask = pdfjsLib.getDocument({
            url: objectUrl,
            ...documentOptions,
        });
        const task = loadingTask;
        const document = await task.promise;
        if (loadingTask === task) {
            loadingTask = null;
        }
        logPdfRenderTrace('pdf-document-get-document-resolve', {
            version,
            sourceKind: 'blob',
            declaredSize: src.size,
            numPages: document.numPages,
            elapsedMs: performance.now() - startedAt,
        });
        return document;
    }

    async function openPath(src: Extract<TPdfSource, {kind: 'path'}>, version: number) {
        const length = src.size;
        if (shouldUseNativePdfPreview(src)) {
            throw new Error(
                `PDF is ${length} bytes; PDF.js is capped at ${PDFJS_NATIVE_PREVIEW_MIN_BYTES} bytes for path-backed documents. Native preview should handle this file.`,
            );
        }
        const initialLength = Math.min(RANGE_CHUNK_BYTES, length);
        const tailStart = Math.max(initialLength, length - RANGE_CHUNK_BYTES);
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
            documentFiles.readFileRange(src.path, 0, initialLength),
            tailStart > initialLength
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
        if (version !== options.getRenderVersion()) {
            return null;
        }
        const optionsStartedAt = performance.now();
        const documentOptions = await getPdfjsDocumentOptions();
        logPdfRenderTrace('pdf-document-options-end', {
            version,
            sourceKind: 'path',
            path: src.path,
            elapsedMs: performance.now() - optionsStartedAt,
        });
        if (version !== options.getRenderVersion()) {
            return null;
        }
        const pdfjsWithRangeTransport = pdfjsLib as typeof pdfjsLib
            & {PDFDataRangeTransport?: TPdfDataRangeTransportCtor};
        const Transport = pdfjsWithRangeTransport.PDFDataRangeTransport;
        if (!Transport) {
            throw new Error('PDF.js range transport API is unavailable');
        }
        rangeTransport = new Transport(length, initialData, false);
        const transport = rangeTransport;
        const preloadedRanges: IPdfPreloadedRange[] = tailData
            ? [{
                begin: tailStart,
                data: tailData,
            }]
            : [];
        const rangeFailure = createRangeReadFailureHandler();
        attachRangeRequestHandler(
            transport,
            src,
            version,
            rangeFailure.failRangeRead,
            preloadedRanges,
        );
        const startedAt = performance.now();
        logPdfRenderTrace('pdf-document-get-document-submit', {
            version,
            sourceKind: 'path',
            path: src.path,
            declaredSize: length,
        });
        loadingTask = pdfjsLib.getDocument({
            range: transport,
            length,
            rangeChunkSize: RANGE_CHUNK_BYTES,
            disableAutoFetch: true,
            disableStream: true,
            ...documentOptions,
        });
        const task = loadingTask;
        const document = await Promise.race([
            task.promise,
            rangeFailure.rangeReadFailure,
        ]);
        if (loadingTask === task) {
            loadingTask = null;
        }
        rangeFailure.complete();
        logPdfRenderTrace('pdf-document-get-document-resolve', {
            version,
            sourceKind: 'path',
            path: src.path,
            declaredSize: length,
            numPages: document.numPages,
            elapsedMs: performance.now() - startedAt,
        });
        return document;
    }

    return {
        setLifecycleKey(lifecycleKey: string) {
            loadingTaskLifecycleKey = lifecycleKey;
        },
        open(src: TPdfSource, version: number): Promise<PDFDocumentProxy | null> {
            return src instanceof Blob ? openBlob(src, version) : openPath(src, version);
        },
        abortTransport,
        destroyLoadingTask,
        revokeObjectUrl,
        clearLoadingTaskHandle() {
            loadingTask = null;
        },
    };
}

/**
 * Cross-component-tree access to the owning session's page leases.
 *
 * Removal condition: delete once the sidebar thumbnail rail and the PDF.js
 * annotation-sync bridge receive `PdfDocumentSession` directly instead of a
 * bare `PDFDocumentProxy`.
 */
const pdfDocumentPageLeaseOwners = new WeakMap<
    PDFDocumentProxy,
    (pageNumber: number, retention: TPdfDocumentPageLeaseRetention) => Promise<IPdfDocumentPageLease>
>();

export function registerPdfDocumentPageLeaseOwner(
    document: PDFDocumentProxy,
    leasePage: (
        pageNumber: number,
        retention: TPdfDocumentPageLeaseRetention,
    ) => Promise<IPdfDocumentPageLease>,
) {
    pdfDocumentPageLeaseOwners.set(document, leasePage);
}

export async function leasePdfDocumentPage(
    document: PDFDocumentProxy,
    pageNumber: number,
    retention: TPdfDocumentPageLeaseRetention = 'render-cache',
) {
    const leasePage = pdfDocumentPageLeaseOwners.get(document);
    if (!leasePage) {
        throw new Error('PDF document page lease owner is unavailable');
    }
    return leasePage(pageNumber, retention);
}
