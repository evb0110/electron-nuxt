/* eslint-disable max-lines -- This established service owns one preview lifecycle, including its detail-raster geometry and caches. */
import {
    mkdir,
    mkdtemp,
    open,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {randomUUID} from 'crypto';
import {
    isAbsolute,
    join,
} from 'path';
import type {
    IScanCleanupDetectionRequest,
    IScanCleanupDetectionResult,
    IScanCleanupDocumentCanvasPlan,
    IScanCleanupOwnerContext,
    IScanCleanupNormalizedRect,
    IScanCleanupPagePlanEvidence,
    IScanCleanupPixelPoint,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewCancelRequest,
    IScanCleanupRawPreviewEvent,
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
    TScanCleanupPreviewWireResult,
    TScanCleanupDetectionStartResult,
    TScanCleanupDetectionJobState,
    TScanCleanupErrorCode,
    TScanCleanupOutputMode,
    TScanCleanupProgress,
} from '@contracts/electronApiScanCleanup';
import type {
    INativeScanCleanupAnalysisOutputV3,
    INativeScanCleanupPageMetadataV3,
    INativeScanCleanupReusableGeometryV3,
    TNativeScanCleanupProgressV3,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import {
    getScanCleanupPageOverride,
    resolveScanCleanupMarginsMm,
    resolveScanCleanupPlacementOffset,
    scanCleanupLayoutSignature,
} from '@contracts/scanCleanupPageOverrides';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';
import {
    readPdfPageSizes,
    type IPdfPageSize,
} from '@electron/pdf/pdfPageSizes';
import {
    CANVAS_CONTENT_SCALE_EPSILON,
    resolveMatchedCanvasResamplePages,
    resolveScanCleanupCanvasFitScale,
    resolveScanCleanupDocumentCanvas,
    SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
} from '@electron/features/scan-cleanup/policy/documentCanvas';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/public';
import {atomicReplace} from '@electron/utils/atomicReplace';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {
    detectSourceDpiDetails,
    detectSourceDpiFromPageSizes,
} from '@electron/pdf/sourceDpiDetection';
import {
    extractPdfMrcLayers,
    extractPdfMrcLayersBatch,
    type IPdfMrcLayers,
} from '@electron/pdf/extractPdfMrcLayers';
import {resolveNativePdfImageCombinePath} from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import {
    renderPdfPageToPng,
    renderPdfPageToPpm,
} from '@electron/ocr/worker/popplerStage';
import type {TWorkerLog} from '@electron/ocr/worker/types';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {runScanCleanupSidecar} from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
import {
    logRasterHandoff,
    readAvailableScratchBytes,
    resolveRasterHandoff,
} from '@electron/features/scan-cleanup/worker/resolveRasterHandoff';
import {readPpmDimensions} from '@electron/features/scan-cleanup/worker/rasterLayerDimensions';
import {preserveScanCleanupJsonEvidence} from '@electron/features/scan-cleanup/worker/preserveScanCleanupJsonEvidence';
import {
    SCAN_CLEANUP_RASTER_SLOT_RESIDENT_BYTES,
    classifyScanCleanupError,
    resolveScanCleanupPath,
    resolveScanCleanupRasterConcurrency,
} from '@electron/features/scan-cleanup/createScanCleanupService';
import {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scanCleanupPlatformFeature';
import {mainJobBroker} from '@electron/resources/jobBroker';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import {buildNativeScanCleanupManifest} from '@electron/features/scan-cleanup/policy/buildNativeScanCleanupManifest';
import {resolveScanCleanupPipelineMaxPixels} from '@electron/features/scan-cleanup/policy/effectiveOptions';
import {
    createMainJobRegistry,
    type IMainJobErrorEnvelope,
    type IMainJobSender,
    type TMainJobSnapshot,
} from '@electron/operation-lifecycle/createMainJobRegistry';
import { ensureWorkingCopyMaterialized } from '@electron/file-access/workingCopyMaterialization';
import {
    getWorkingCopyBackingEntry,
    getWorkingCopyBackingMetadata,
} from '@electron/file-access/workingCopyStore';

const PREVIEW_DPI = 150;
// Native mode selection and final rendering share a 150-DPI analysis ceiling.
// A proven lower-resolution scan is analyzed on its own grid: upsampling it for
// detection produces text-tone evidence that cannot be replayed by the final
// renderer on the source grid.
const DETECTION_DPI = 150;
const DETAIL_TILE_MAX_PIXELS = 4_000_000;
const BASE_PREVIEW_MAX_PIXELS = 4_000_000;
const DEFAULT_SOURCE_DPI = 300;
const PREVIEW_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const BASE_ANALYSIS_CACHE_PAGE_LIMIT = 32;
// Canonical cleaned previews are retained only so detail tiles can replay the
// exact page-global pixel transform. Bound them independently of the renderer
// payloads so browsing a long document cannot turn detail parity into an
// unbounded main-process heap.
const BASE_ANALYSIS_CACHE_BYTE_LIMIT = 64 * 1024 * 1024;
const RAW_RASTER_RETENTION_PREFIX = 'scan-cleanup-rasters-';
// How long a background prefetch may wait for the machine before it is dropped.
// A prefetch is an optimisation, so it must never be the reason a page the user
// later opens is already committed to a reservation nothing can grant.
const PREVIEW_PREFETCH_LEASE_TIMEOUT_MS = 10_000;
const PREVIEW_ADMISSION_REISSUED = new Error('Scan cleanup preview readmitted at visible priority');
const logger = createLogger('scan-cleanup-preview');

function resolvePagePreviewDpi(
    pageSize: IPdfPageSize,
    requestedDpi: number,
) {
    const pageAreaPoints = pageSize.widthPoints * pageSize.heightPoints;
    if (!Number.isFinite(pageAreaPoints) || pageAreaPoints <= 0) {
        return requestedDpi;
    }
    const pixelBoundDpi = 72 * Math.sqrt(BASE_PREVIEW_MAX_PIXELS / pageAreaPoints);
    return Math.max(1, Math.floor(Math.min(requestedDpi, pixelBoundDpi)));
}

function resolvePreviewRasterPlan(pageSizes: readonly IPdfPageSize[] | null) {
    const detected = pageSizes === null ? null : detectSourceDpiFromPageSizes(pageSizes);
    const documentDpi = detected?.documentDpi ?? PREVIEW_DPI;
    const dpi = Math.min(PREVIEW_DPI, documentDpi);
    const renderDpiByPageNumber = new Map<number, number>();
    const detectionDpiByPageNumber = new Map<number, number>();
    for (const pageSize of pageSizes ?? []) {
        const sourceDpi = detected?.pageDpiByNumber.get(pageSize.pageNumber);
        const requestedDpi = Math.min(PREVIEW_DPI, sourceDpi ?? dpi);
        const renderDpi = resolvePagePreviewDpi(pageSize, requestedDpi);
        renderDpiByPageNumber.set(pageSize.pageNumber, renderDpi);
        detectionDpiByPageNumber.set(
            pageSize.pageNumber,
            Math.min(DETECTION_DPI, renderDpi),
        );
    }
    return {
        dpi,
        detectionDpiByPageNumber,
        pageDpiByNumber: detected?.pageDpiByNumber ?? new Map<number, number>(),
        renderDpiByPageNumber,
    };
}

/**
 * Where the document keeps its own pixels. `detected` is false when pdfimages
 * is unavailable, which means every page has to be treated as one that carries
 * a raster: there is no evidence that it does not.
 */
export interface IScanCleanupDocumentRasterPages {
    detected: boolean;
    pages: ReadonlySet<number>;
    bilevelLayerPages?: ReadonlySet<number>;
    backgroundDpiByPage?: ReadonlyMap<number, number>;
}

interface IRetainedDocument {
    dir: Promise<string>;
    documentRevision: string;
    // Aborted when the document is discarded. Every measurement of this
    // document runs under it, so closing the session stops the native work
    // nobody is waiting for any more, without any one caller's cancellation
    // reaching work the others share.
    lifetime: AbortController;
    mtimeMs: number;
    pageCount: Promise<number> | null;
    // The paper rectangle of every page, measured once from the source: see
    // resolveDocumentMeasurement. The canvas a matched page is normalized onto
    // is derived from it alone.
    pageSizes: Promise<IPdfPageSize[]> | null;
    // Which pages carry a raster of their own, and whether that could be
    // detected at all. A matched lossless run has to re-render a document whose
    // rasters would otherwise sit on the shared sheet at two resolutions, so a
    // preview that promises lossless needs the same answer the run will reach.
    rasterPages: Promise<IScanCleanupDocumentRasterPages> | null;
    pinned: number;
    removeWhenIdle: boolean;
    sourcePdfPath: string;
}

interface IRetainedRawRaster {
    document: IRetainedDocument;
    dpi: number;
    height: number;
    pageNumber: number;
    path: string;
    sizeBytes: number;
    width: number;
}

interface IRawPreview extends IRetainedRawRaster {
    bytes: Uint8Array;
    totalPages: number;
}

interface ILosslessPreviewAnalysisOutput {
    half: IScanCleanupPreviewMetadata['half'];
    sourceRegion: IScanCleanupPreviewMetadata['sourceRegion'];
    contentBox: IScanCleanupPreviewMetadata['contentBox'];
    contentDiagnostics?: IScanCleanupPreviewMetadata['contentDiagnostics'];
    textToneDiagnostics?: IScanCleanupPreviewMetadata['textToneDiagnostics'];
    cropRect: IScanCleanupPreviewMetadata['sourceRegion'];
    appliedMargins: IScanCleanupPreviewMetadata['appliedMargins'];
    inputWidthPx: number;
    inputHeightPx: number;
}

type ILosslessPreviewPageMetadata = IScanCleanupPreviewResult['pageMetadata'] & {outputs?: ILosslessPreviewAnalysisOutput[]};

type INativePreviewOutputMetadata = IScanCleanupPreviewMetadata
    & INativeScanCleanupReusableGeometryV3 & {dewarpModel?: unknown;};

interface IBasePreviewAnalysis {
    sourcePdfPath: string;
    documentRevision: string;
    mtimeMs: number;
    outputMode?: TScanCleanupOutputMode;
    pageMetadata: IScanCleanupPreviewResult['pageMetadata'];
    outputs: Partial<Record<IScanCleanupPreviewMetadata['half'], INativePreviewOutputMetadata>>;
    canonicalRasters: Partial<Record<IScanCleanupPreviewMetadata['half'], Uint8Array>>;
    canonicalRasterBytes: number;
}

// A run's admission is mutable for as long as it is still waiting for one: a
// prefetch the user navigates onto becomes the visible page and must be
// readmitted as one, because the reservation a background run asks for can be
// ungrantable for as long as detection holds the machine.
interface IPreviewAdmission {
    granted: boolean;
    reissue: (() => void) | null;
    visibility: TPreviewVisibility;
}

interface IPreviewEntry {
    admission: IPreviewAdmission;
    controller: AbortController;
    generation: number;
    pageNumber: number;
    tail: Promise<TScanCleanupPreviewWireResult>;
}

interface IDetectionResult {results: TScanCleanupDetectionJobState['results'];}

type TDetectionError = IMainJobErrorEnvelope<TScanCleanupErrorCode>;
type TDetectionSnapshot = TMainJobSnapshot<TScanCleanupDetectionJobState, IDetectionResult, TDetectionError>;
export interface IScanCleanupDetectionSubscriber extends IMainJobSender {id: number;}

type TPreviewVisibility = 'visible' | 'prefetch';

export interface IScanCleanupPreviewDependencies {
    getPageCount: typeof getPdfPageCount;
    getPageSizes: typeof readPdfPageSizes;
    prefetchLeaseTimeoutMs?: number;
    publishRaster: typeof atomicReplace;
    renderPage: typeof renderPdfPageToPng;
    renderPagePpm: typeof renderPdfPageToPpm;
    createRasterPipes?: (
        paths: readonly string[],
        signal: AbortSignal,
        log: TWorkerLog,
    ) => Promise<void>;
    runSidecar: typeof runScanCleanupSidecar;
    resolveBinary: () => string | null;
    resolvePageOpsBinary: () => string | null;
    resolvePdfInfoBinary?: () => string | undefined;
    getTempDir: () => string;
    getPdftoppmBinary: () => string;
    detectSourceDpi?: (sourcePdfPath: string, pageNumber: number, signal: AbortSignal) => Promise<number | null>;
    detectRasterPages?: (
        sourcePdfPath: string,
        signal: AbortSignal,
        pageNumbers: readonly number[],
    ) => Promise<IScanCleanupDocumentRasterPages>;
    extractMrcLayers?: (
        sourcePdfPath: string,
        pageNumber: number,
        selectionMaskOutputPath: string,
        backgroundOutputPath: string,
        signal: AbortSignal,
        log: TWorkerLog,
    ) => Promise<IPdfMrcLayers | null>;
    acquireDetectionLease?: (jobId: string, signal: AbortSignal) => Promise<{release: () => boolean}>;
    acquirePreviewLease?: (
        ownerId: string,
        visibility: TPreviewVisibility,
        signal: AbortSignal,
    ) => Promise<{release: () => boolean}>;
    getSourceMtimeMs?: (sourcePdfPath: string) => Promise<number>;
    materializeWorkingCopy: typeof ensureWorkingCopyMaterialized;
}

const defaultDependencies: IScanCleanupPreviewDependencies = {
    getPageCount: getPdfPageCount,
    getPageSizes: readPdfPageSizes,
    publishRaster: atomicReplace,
    renderPage: renderPdfPageToPng,
    renderPagePpm: renderPdfPageToPpm,
    createRasterPipes: async (paths, signal, log) => {
        await runNativeToolCommand('mkfifo', [...paths], {
            signal,
            commandLabel: 'mkfifo(scan-cleanup-detection-streams)',
            log,
        });
    },
    runSidecar: runScanCleanupSidecar,
    resolveBinary: resolveScanCleanupPath,
    resolvePageOpsBinary: () => (isNativePageOpsDisabled() ? null : resolveNativePageOpsPath()),
    resolvePdfInfoBinary: () => getPdfNativeToolPaths().pdfinfo,
    getTempDir: getAppTempDir,
    getPdftoppmBinary: () => getPdfNativeToolPaths().pdftoppm,
    detectSourceDpi: async (sourcePdfPath, pageNumber, signal) => {
        const paths = getPdfNativeToolPaths();
        const result = await detectSourceDpiDetails(
            sourcePdfPath,
            paths.pdfimages,
            (level, message) => logger[level](message),
            undefined,
            signal,
            [pageNumber],
        );
        return result.pageDpiByNumber.get(pageNumber) ?? null;
    },
    detectRasterPages: async (sourcePdfPath, signal, pageNumbers) => {
        const paths = getPdfNativeToolPaths();
        const result = await detectSourceDpiDetails(
            sourcePdfPath,
            paths.pdfimages,
            (level, message) => logger[level](message),
            undefined,
            signal,
            pageNumbers,
        );
        return {
            detected: paths.pdfimages !== undefined,
            pages: new Set(result.pageRasterByNumber.keys()),
            bilevelLayerPages: new Set(
                [...result.pageRasterByNumber]
                    .filter(([
                        , raster,
                    ]) => raster.hasBilevelLayer)
                    .map(([pageNumber]) => pageNumber),
            ),
            backgroundDpiByPage: new Map(
                [...result.pageRasterByNumber].flatMap(([
                    pageNumber,
                    raster,
                ]) =>
                    raster.backgroundDpi === undefined
                        ? []
                        : [[
                            pageNumber,
                            raster.backgroundDpi,
                        ] as const],
                ),
            ),
        };
    },
    extractMrcLayers: async (
        sourcePdfPath,
        pageNumber,
        selectionMaskOutputPath,
        backgroundOutputPath,
        signal,
        log,
    ) => {
        const paths = getPdfNativeToolPaths();
        const pdfImageCombineBinary = resolveNativePdfImageCombinePath();
        if (pdfImageCombineBinary !== null) {
            // The native raster reader intentionally dispatches by extension:
            // compact JBIG2 selections and decoded PPM backgrounds must retain
            // their real formats even though the legacy preview extractor's
            // caller-facing destinations predate those representations.
            const compactSelectionPath = `${selectionMaskOutputPath}.jb2e`;
            const decodedBackgroundPath = `${backgroundOutputPath}.ppm`;
            const extracted = await extractPdfMrcLayersBatch({
                pdfPath: sourcePdfPath,
                targets: [{
                    pageNumber,
                    selectionMaskOutputPath: compactSelectionPath,
                    backgroundOutputPath: decodedBackgroundPath,
                    foregroundOutputPath: `${backgroundOutputPath}.foreground.jp2`,
                }],
                pdfimagesBinary: paths.pdfimages,
                qpdfBinary: paths.qpdf,
                pdfImageCombineBinary,
                pdftoppmBinary: paths.pdftoppm,
                runCommand: runNativeToolCommand,
                log,
                signal,
            });
            return extracted.get(pageNumber) ?? null;
        }
        return extractPdfMrcLayers({
            pdfPath: sourcePdfPath,
            pageNumber,
            selectionMaskOutputPath,
            backgroundOutputPath,
            foregroundOutputPath: `${backgroundOutputPath}.foreground.jp2`,
            pdfimagesBinary: paths.pdfimages,
            runCommand: runNativeToolCommand,
            log,
            signal,
        });
    },
    acquireDetectionLease: (jobId, signal) => {
        const rasterConcurrency = resolveScanCleanupRasterConcurrency();
        return mainJobBroker.acquire({
            ownerId: jobId,
            kind: 'scan-cleanup-detect-all',
            priority: 'foreground',
            resources: {
                cpuTokens: rasterConcurrency,
                estimatedResidentBytes: rasterConcurrency * SCAN_CLEANUP_RASTER_SLOT_RESIDENT_BYTES,
                nativeProcesses: rasterConcurrency,
                ioWeight: 2,
            },
            perOwnerLimit: 1,
            signal,
        });
    },
    acquirePreviewLease: (ownerId, visibility, signal) => {
        const {capacity} = mainJobBroker.getSnapshot();
        // A preview run rasterizes a page and then hands it to one sidecar; it
        // never runs both at once, so a single native process is its true peak.
        // A prefetch additionally claims the slot the raster concurrency leaves
        // free (SCAN_CLEANUP_RASTER_BROKER_PROCESS_RESERVE), so background work
        // only starts when the machine has room beyond the one process a page
        // switch must always be able to start immediately.
        const nativeProcesses = visibility === 'visible' ? 1 : Math.min(2, capacity.nativeProcesses);
        return mainJobBroker.acquire({
            ownerId,
            kind: 'scan-cleanup-preview',
            priority: visibility === 'visible' ? 'visible' : 'background',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: SCAN_CLEANUP_RASTER_SLOT_RESIDENT_BYTES,
                nativeProcesses,
                ioWeight: 1,
            },
            signal,
        });
    },
    getSourceMtimeMs: async sourcePdfPath => (await stat(sourcePdfPath)).mtimeMs,
    materializeWorkingCopy: (logicalRef, options) => {
        // Preview work is queued, so the owning tab can close or reopen the
        // document before the tail runs. A registration this owner held and
        // that has since been retired or replaced makes the request moot, and
        // it is reported as a cancellation rather than letting the materializer
        // raise an ownership error out of the IPC handler. A path this owner
        // never held is a real failure and keeps its error, so an unmanaged or
        // wrong-owner source is not hidden behind a spinner.
        if (
            !getWorkingCopyBackingEntry(logicalRef, options.ownerWebContentsId)
            && getWorkingCopyBackingMetadata(logicalRef, options.ownerWebContentsId)?.retired === true
        ) {
            return Promise.reject(new DOMException(
                'Scan cleanup source is no longer available',
                'AbortError',
            ));
        }
        return ensureWorkingCopyMaterialized(logicalRef, options);
    },
};

// Turning a page cancels the render of the page being left. That is the normal
// course of a session, not a failure, so it answers the invoke instead of
// rejecting it: a rejected invoke is logged by Electron as a handler error and
// would bury the failures worth reading.
function isPreviewCancellation(error: unknown) {
    return error instanceof Error
        && (error.name === 'AbortError'
            || (error as {code?: unknown}).code === 'WORKING_COPY_MATERIALIZATION_CANCELLED');
}

async function materializeScanCleanupPreviewRequest<
    T extends IScanCleanupPreviewRequest | IScanCleanupDetectionRequest,
>(
    request: T,
    senderId: number,
    signal: AbortSignal,
    dependencies: IScanCleanupPreviewDependencies,
): Promise<T> {
    signal.throwIfAborted();
    const materialized = await dependencies.materializeWorkingCopy(request.sourcePdfPath, {
        ownerWebContentsId: senderId,
        reason: 'scan-cleanup',
        signal,
    });
    return {
        ...request,
        sourcePdfPath: materialized.physicalWorkingCopyPath,
    };
}

// Detection and preview render the same page at the same DPI with the same
// arguments, so a rendered raster is kept in a document-scoped directory keyed
// by the source path, the document revision and the source mtime, and whoever
// asks for that page next reads the file instead of spawning pdftoppm again.
// The directory holds paths and dimensions only: the bytes are read on demand
// and never held, and the retained footprint is bounded by the same scratch
// budget the final-run pipeline spends through resolveRasterHandoff.
function createRawRasterRetention(dependencies: IScanCleanupPreviewDependencies) {
    const documents = new Map<string, IRetainedDocument>();
    const opening = new Map<string, Promise<IRetainedDocument>>();
    const rasters = new Map<string, IRetainedRawRaster>();
    let retainedBytes = 0;
    let root: Promise<string> | null = null;
    let budget: Promise<number> | null = null;

    const remove = (path: string) => {
        void rm(path, {
            force: true,
            recursive: true,
        }).catch(error => logger.warn(`Failed to drop a retained scan cleanup raster: ${getErrorMessage(error)}`));
    };
    // A raster is a function of the document identity, the page and the DPI
    // alone, so it has exactly one path inside the document's directory. A
    // re-render publishes over that path through atomicReplace, which is the
    // same replace-in-place the rest of the app commits files with: a consumer
    // that captured the path for a sidecar manifest keeps reading a complete
    // raster with the bytes it asked for instead of finding the file another
    // request unlinked underneath it, and on Windows a live destination is
    // moved aside rather than failing the rename with EPERM/EACCES.
    const stableRasterPath = (dir: string, pageNumber: number, dpi: number) => join(dir, `page-${pageNumber}-${dpi}.png`);
    const rasterKey = (document: IRetainedDocument, pageNumber: number, dpi: number) => JSON.stringify([
        document.sourcePdfPath,
        document.documentRevision,
        document.mtimeMs,
        pageNumber,
        dpi,
    ]);
    const forget = (key: string, raster: IRetainedRawRaster) => {
        rasters.delete(key);
        retainedBytes -= raster.sizeBytes;
    };
    const ensureRoot = () => {
        root ??= (async () => {
            // One directory per process run: retention is a within-run cache,
            // not a durable artifact store, and a reused pid must not inherit a
            // dead run's rasters.
            const path = join(dependencies.getTempDir(), `${RAW_RASTER_RETENTION_PREFIX}${process.pid}`);
            await rm(path, {
                force: true,
                recursive: true,
            });
            await mkdir(path, {recursive: true});
            return path;
        })();
        return root;
    };
    const resolveBudgetBytes = () => {
        budget ??= ensureRoot()
            .then(path => resolveRasterHandoff([], path, readAvailableScratchBytes))
            .then(handoff => handoff.budgetBytes ?? 0);
        return budget;
    };
    const discard = (document: IRetainedDocument) => {
        for (const [
            key,
            raster,
        ] of rasters) {
            if (raster.document === document) forget(key, raster);
        }
        if (documents.get(document.sourcePdfPath) === document) documents.delete(document.sourcePdfPath);
        document.lifetime.abort(new DOMException('Scan cleanup document was closed', 'AbortError'));
        // A request from another window may still be rendering into this
        // directory or feeding one of its rasters to a sidecar, so the files
        // outlive the invalidation that dropped them from the index.
        if (document.pinned > 0) {
            document.removeWhenIdle = true;
            return;
        }
        void document.dir.then(remove, () => undefined);
    };
    const prune = async () => {
        const budgetBytes = await resolveBudgetBytes();
        for (const [
            key,
            raster,
        ] of rasters) {
            if (retainedBytes <= budgetBytes) {
                return;
            }
            if (raster.document.pinned > 0) continue;
            forget(key, raster);
            remove(raster.path);
        }
    };
    const resolveDocument = async (
        request: Pick<IScanCleanupPreviewRequest, 'sourcePdfPath' | 'documentRevision'>,
    ) => {
        const mtimeMs = await dependencies.getSourceMtimeMs?.(request.sourcePdfPath) ?? 0;
        const current = documents.get(request.sourcePdfPath);
        if (
            current
            && current.documentRevision === request.documentRevision
            && current.mtimeMs === mtimeMs
        ) {
            current.pinned += 1;
            return current;
        }
        if (current) discard(current);
        const document: IRetainedDocument = {
            dir: ensureRoot().then(async path => {
                const dir = join(path, randomUUID());
                await mkdir(dir, {recursive: true});
                return dir;
            }),
            documentRevision: request.documentRevision,
            lifetime: new AbortController(),
            mtimeMs,
            pageCount: null,
            pageSizes: null,
            rasterPages: null,
            pinned: 1,
            removeWhenIdle: false,
            sourcePdfPath: request.sourcePdfPath,
        };
        documents.set(request.sourcePdfPath, document);
        return document;
    };

    // A measurement of the document is shared by everyone who asks for it, so
    // it must not carry any one caller's cancellation. It runs under the
    // document's own lifetime instead, and each awaiter races it against its
    // own signal: a dropped prefetch that started the measurement stops waiting
    // for it while the visible page it was measuring for still gets the answer,
    // and closing the document stops the native process for everyone. A failed
    // measurement is forgotten so the next request measures again; a successful
    // one is kept for the life of the document.
    const resolveDocumentMeasurement = <TValue>(
        slot: {
            read: () => Promise<TValue> | null;
            write: (value: Promise<TValue> | null) => void;
        },
        signal: AbortSignal,
        measure: () => Promise<TValue>,
    ) => {
        signal.throwIfAborted();
        let pending = slot.read();
        if (!pending) {
            pending = measure();
            slot.write(pending);
            const started = pending;
            void started.catch(() => {
                if (slot.read() === started) slot.write(null);
            });
        }
        const shared = pending;
        return new Promise<TValue>((resolve, reject) => {
            const onAbort = () => {
                reject(signal.reason instanceof Error
                    ? signal.reason
                    : new DOMException('Scan cleanup document measurement was abandoned', 'AbortError'));
            };
            signal.addEventListener('abort', onAbort, {once: true});
            shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
        });
    };
    const resolvePageCount = (document: IRetainedDocument, signal: AbortSignal) => resolveDocumentMeasurement(
        {
            read: () => document.pageCount,
            write: value => {
                document.pageCount = value;
            },
        },
        signal,
        () => dependencies.getPageCount(document.sourcePdfPath, {signal: document.lifetime.signal}),
    );
    // The paper rectangle of every page, which is what a matched canvas is
    // measured from. It answers from page metadata before a single page has
    // been rendered and is the same for every page and for the final run, so
    // the frame does not move as pages are previewed — with one exception the
    // preview names rather than hides: the canvas is also measured from the
    // layouts detection has settled, and a pass that turns a page into a spread
    // does change the rectangle every page is drawn on. That is why a preview
    // is keyed by the spread layouts it was measured against, and why the
    // preview pane says so while detection is still running.
    //
    // A measurement that fails is *not* an answer: it is rejected and
    // forgotten, so the next request measures again instead of the session
    // holding a failure. Its caller drops matching for that request and warns.
    const resolvePageSizes = (document: IRetainedDocument, signal: AbortSignal) => resolveDocumentMeasurement(
        {
            read: () => document.pageSizes,
            write: value => {
                document.pageSizes = value;
            },
        },
        signal,
        async () => {
            try {
                const pdfPageOpsBinary = dependencies.resolvePageOpsBinary();
                const pdfinfoBinary = dependencies.resolvePdfInfoBinary?.();
                if (!pdfPageOpsBinary && !pdfinfoBinary) {
                    throw new Error('no PDF tool is available to read page geometry');
                }
                return await dependencies.getPageSizes(document.sourcePdfPath, {
                    ...(pdfPageOpsBinary ? {pdfPageOpsBinary} : {}),
                    ...(pdfinfoBinary ? {pdfinfoBinary} : {}),
                    tempDir: await document.dir,
                    signal: document.lifetime.signal,
                    log: (level, message) => logger[level](message),
                });
            } catch (error) {
                logger.warn(`Scan cleanup could not measure the document canvas: ${getErrorMessage(error)}`);
                throw new Error(
                    `Scan cleanup could not measure this document's page sizes, which matched page size needs: ${getErrorMessage(error)}`,
                );
            }
        },
    );

    // Where the document's own rasters are, measured once per document. Only a
    // matched lossless preview asks: it is the one case where the answer decides
    // whether the run this preview is standing in for can stay lossless at all.
    const resolveRasterPages = (document: IRetainedDocument, signal: AbortSignal) => resolveDocumentMeasurement(
        {
            read: () => document.rasterPages,
            write: value => {
                document.rasterPages = value;
            },
        },
        signal,
        async () => {
            if (!dependencies.detectRasterPages) {
                return {
                    detected: false,
                    pages: new Set<number>(),
                    bilevelLayerPages: new Set<number>(),
                    backgroundDpiByPage: new Map<number, number>(),
                };
            }
            const totalPages = await resolvePageCount(document, document.lifetime.signal);
            const pageNumbers = Array.from({length: totalPages}, (_, index) => index + 1);
            return dependencies.detectRasterPages(
                document.sourcePdfPath,
                document.lifetime.signal,
                pageNumbers,
            );
        },
    );

    return {
        // Serialized per source path so two concurrent requests cannot each
        // create a directory for the same document. The returned document is
        // already pinned, so nothing can invalidate its directory between the
        // lookup and the caller's first render; every caller releases it.
        openDocument(request: Pick<IScanCleanupPreviewRequest, 'sourcePdfPath' | 'documentRevision'>) {
            const pending = (opening.get(request.sourcePdfPath) ?? Promise.resolve())
                .then(() => resolveDocument(request), () => resolveDocument(request));
            opening.set(request.sourcePdfPath, pending);
            return pending;
        },
        // qpdf --show-npages costs over a second on a cold document for a value
        // that cannot change while the revision and the mtime hold.
        pageCount: resolvePageCount,
        pageSizes: resolvePageSizes,
        rasterPages: resolveRasterPages,
        // Where a render writes before it is published: private to the render,
        // so an abandoned or failed one leaves the page's retained raster alone.
        // pdftoppm derives its own output name by dropping the extension, so
        // this stays a .png path with the run's identity in front of it.
        async rasterScratchPath(document: IRetainedDocument, pageNumber: number, dpi: number) {
            return join(await document.dir, `page-${pageNumber}-${dpi}.${randomUUID()}.part.png`);
        },
        // Which of these pages the index can hand over as a file, without
        // reading a byte. A raster is a function of the source, the revision,
        // the mtime, the page and the DPI alone, so a caller that re-renders a
        // page held here would produce the same file it already has.
        async retainedPaths(document: IRetainedDocument, pageNumbers: readonly number[], dpi: number) {
            const retained = new Map<number, IRetainedRawRaster>();
            for (const pageNumber of pageNumbers) {
                const key = rasterKey(document, pageNumber, dpi);
                const raster = rasters.get(key);
                if (!raster) {
                    continue;
                }
                try {
                    await stat(raster.path);
                } catch {
                    forget(key, raster);
                    continue;
                }
                // Re-insert so a reused raster counts as the most recent use and
                // the budget sweep drops a colder page first.
                rasters.delete(key);
                rasters.set(key, raster);
                retained.set(pageNumber, raster);
            }
            return retained;
        },
        async read(document: IRetainedDocument, pageNumber: number, dpi: number) {
            const key = rasterKey(document, pageNumber, dpi);
            const raster = rasters.get(key);
            if (!raster) {
                return null;
            }
            rasters.delete(key);
            try {
                const bytes = await readPreviewBytes(raster.path);
                rasters.set(key, raster);
                return {
                    bytes,
                    raster,
                };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    rasters.set(key, raster);
                    throw error;
                }
                retainedBytes -= raster.sizeBytes;
                return null;
            }
        },
        // Publishes a rendered scratch raster onto the page's stable path. The
        // previous file at that path is replaced, never unlinked, so a manifest
        // another request is still feeding to a sidecar stays readable.
        async retain(rendered: Omit<IRetainedRawRaster, 'path'> & {scratchPath: string}) {
            const path = stableRasterPath(await rendered.document.dir, rendered.pageNumber, rendered.dpi);
            await dependencies.publishRaster(rendered.scratchPath, path, {
                durable: false,
                markMutationCommitStarted: false,
            });
            const key = rasterKey(rendered.document, rendered.pageNumber, rendered.dpi);
            const previous = rasters.get(key);
            if (previous) forget(key, previous);
            const raster: IRetainedRawRaster = {
                document: rendered.document,
                dpi: rendered.dpi,
                height: rendered.height,
                pageNumber: rendered.pageNumber,
                path,
                sizeBytes: rendered.sizeBytes,
                width: rendered.width,
            };
            rasters.set(key, raster);
            retainedBytes += raster.sizeBytes;
            await prune();
            return raster;
        },
        remove,
        // A request holds its document for as long as it may render into the
        // directory or hand one of its rasters to a sidecar: the budget sweep
        // skips a pinned document, and an invalidated one is removed only once
        // the last request using it has finished.
        async release(document: IRetainedDocument) {
            document.pinned = Math.max(0, document.pinned - 1);
            if (document.pinned > 0) {
                return;
            }
            if (document.removeWhenIdle) {
                void document.dir.then(remove, () => undefined);
                return;
            }
            await prune();
        },
        invalidate(sourcePdfPath: string, documentRevision: string) {
            const document = documents.get(sourcePdfPath);
            if (document?.documentRevision === documentRevision) discard(document);
        },
    };
}

type TRawRasterRetention = ReturnType<typeof createRawRasterRetention>;

async function materializeRawRaster(
    document: IRetainedDocument,
    pageNumber: number,
    signal: AbortSignal,
    retention: TRawRasterRetention,
    dependencies: IScanCleanupPreviewDependencies,
    knownTotalPages?: number,
    dpi = PREVIEW_DPI,
): Promise<IRawPreview> {
    const retained = await retention.read(document, pageNumber, dpi);
    if (retained) {
        return {
            ...retained.raster,
            bytes: retained.bytes,
            totalPages: knownTotalPages ?? await retention.pageCount(document, signal),
        };
    }
    const totalPages = knownTotalPages ?? await retention.pageCount(document, signal);
    if (pageNumber > totalPages) throw new Error('Scan cleanup preview page is out of range');
    const scratchPath = await retention.rasterScratchPath(document, pageNumber, dpi);
    await dependencies.renderPage(
        {pdftoppmBinary: dependencies.getPdftoppmBinary()},
        (level, message) => logger[level](message),
        pageNumber,
        document.sourcePdfPath,
        scratchPath,
        dpi,
        undefined,
        signal,
    );
    const bytes = await readPreviewBytes(scratchPath);
    if (signal.aborted) {
        retention.remove(scratchPath);
        throw signal.reason;
    }
    const raster = await retention.retain({
        document,
        dpi,
        ...readPngDimensions(bytes),
        pageNumber,
        scratchPath,
        sizeBytes: bytes.byteLength,
    });
    return {
        ...raster,
        bytes,
        totalPages,
    };
}

/**
 * The page and the settings that decide what a render would produce — including
 * the layouts the matched canvas is measured from, because a request that would
 * be placed on another rectangle is not the same request.
 */
function previewIdentityKey(request: Omit<IScanCleanupPreviewRequest, 'detail'>) {
    return JSON.stringify({
        sourcePdfPath: request.sourcePdfPath,
        documentRevision: request.documentRevision,
        pageNumber: request.pageNumber,
        options: request.options,
        documentPrior: request.documentPrior ?? null,
        // This resolves Auto before the sidecar runs. Two otherwise identical
        // requests with different recommendations produce different pixels and
        // must neither share nor adopt the same in-flight render.
        outputModeRecommendation: request.outputModeRecommendation ?? null,
        softAlphaForegroundRecommendation: request.softAlphaForegroundRecommendation ?? null,
        layouts: request.options.matchPageSize
            ? scanCleanupLayoutSignature(request.layoutByPage ?? {})
            : '',
    });
}

/**
 * The identity above plus the rectangle and grid the page was actually
 * normalized onto. The canvas is derived from the document alone, so it rarely
 * moves — but an entry is keyed by what the render placed the page on rather
 * than by the reasoning that produced it.
 */
function baseAnalysisKey(
    request: Omit<IScanCleanupPreviewRequest, 'detail'>,
    documentCanvas: IScanCleanupDocumentCanvasPlan | null,
) {
    // Output mode changes pixels, but not the reusable geometric analysis a
    // detail tile consumes. Keep adoption identity mode-sensitive while
    // letting a tile find the base geometry even when Auto was resolved after
    // that base run started.
    const {
        outputModeRecommendation: _outputModeRecommendation,
        softAlphaForegroundRecommendation: _softAlphaForegroundRecommendation,
        ...geometryRequest
    } = request;
    return JSON.stringify({
        identity: previewIdentityKey(geometryRequest),
        documentCanvas,
    });
}

function pruneBaseAnalysisCache(cache: Map<string, IBasePreviewAnalysis>) {
    let retainedBytes = [...cache.values()]
        .reduce((total, analysis) => total + analysis.canonicalRasterBytes, 0);
    while (
        cache.size > BASE_ANALYSIS_CACHE_PAGE_LIMIT
        || retainedBytes > BASE_ANALYSIS_CACHE_BYTE_LIMIT
    ) {
        const oldest = cache.entries().next().value;
        if (!oldest) {
            return;
        }
        cache.delete(oldest[0]);
        retainedBytes -= oldest[1].canonicalRasterBytes;
    }
}

function resolveFallbackDetailDpi(
    request: IScanCleanupPreviewRequest & {detail: NonNullable<IScanCleanupPreviewRequest['detail']>},
    raw: Pick<IRawPreview, 'width' | 'height' | 'dpi'>,
    sourceDpi: number,
    documentCanvas: IScanCleanupDocumentCanvasPlan | null,
) {
    const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, request.pageNumber);
    const swapsAxes = pageOverride.rotationDegrees === 90 || pageOverride.rotationDegrees === 270;
    const margins = resolveScanCleanupMarginsMm(request.options.marginsMm, pageOverride);
    const widthAtPreviewDpi = (swapsAxes ? raw.height : raw.width)
        + (margins.leftMm + margins.rightMm) / 25.4 * raw.dpi;
    const heightAtPreviewDpi = (swapsAxes ? raw.width : raw.height)
        + (margins.topMm + margins.bottomMm) / 25.4 * raw.dpi;
    const canvasWidth = request.options.matchPageSize && documentCanvas ? documentCanvas.widthPx : 0;
    const canvasHeight = request.options.matchPageSize && documentCanvas ? documentCanvas.heightPx : 0;
    const budgetDpi = raw.dpi * Math.sqrt(
        DETAIL_TILE_MAX_PIXELS * 0.98
        / (Math.max(1, widthAtPreviewDpi, canvasWidth)
            * Math.max(1, heightAtPreviewDpi, canvasHeight)),
    );
    const requestedRenderDpi = Math.max(sourceDpi, raw.dpi);
    return {
        renderDpi: Math.max(1, Math.floor(Math.min(requestedRenderDpi, budgetDpi))),
        requestedRenderDpi,
    };
}

function applyPreviewAffine(
    affine: NonNullable<IScanCleanupPreviewMetadata['forwardTransform']>,
    point: IScanCleanupPixelPoint,
) {
    return {
        x: affine.matrix[0]![0]! * point.x
            + affine.matrix[0]![1]! * point.y
            + affine.matrix[0]![2]!,
        y: affine.matrix[1]![0]! * point.x
            + affine.matrix[1]![1]! * point.y
            + affine.matrix[1]![2]!,
    };
}

function interpolateDewarpOutputToSource(
    mapping: NonNullable<INativeScanCleanupReusableGeometryV3['dewarpMapping']>,
    point: IScanCleanupPixelPoint,
) {
    if (
        mapping.columns < 2
        || mapping.rows < 2
        || mapping.outputWidth <= 0
        || mapping.outputHeight <= 0
        || mapping.outputToSource.length !== mapping.columns * mapping.rows
    ) {
        throw new Error('Scan cleanup base preview has an invalid dewarp mapping');
    }
    const gridX = Math.max(0, Math.min(
        mapping.columns - 1,
        point.x / mapping.outputWidth * (mapping.columns - 1),
    ));
    const gridY = Math.max(0, Math.min(
        mapping.rows - 1,
        point.y / mapping.outputHeight * (mapping.rows - 1),
    ));
    const left = Math.floor(gridX);
    const top = Math.floor(gridY);
    const right = Math.min(mapping.columns - 1, left + 1);
    const bottom = Math.min(mapping.rows - 1, top + 1);
    const tx = gridX - left;
    const ty = gridY - top;
    const at = (column: number, row: number) => mapping.outputToSource[row * mapping.columns + column]!;
    const topLeft = at(left, top);
    const topRight = at(right, top);
    const bottomLeft = at(left, bottom);
    const bottomRight = at(right, bottom);
    return {
        x: (topLeft.x * (1 - tx) + topRight.x * tx) * (1 - ty)
            + (bottomLeft.x * (1 - tx) + bottomRight.x * tx) * ty,
        y: (topLeft.y * (1 - tx) + topRight.y * tx) * (1 - ty)
            + (bottomLeft.y * (1 - tx) + bottomRight.y * tx) * ty,
    };
}

function inverseRotatePreviewPoint(
    point: IScanCleanupPixelPoint,
    metadata: Pick<
        IScanCleanupPreviewMetadata,
        'inputWidthPx' | 'inputHeightPx' | 'rotationDegrees'
    >,
) {
    switch (metadata.rotationDegrees) {
        case 90:
            return {
                x: point.y,
                y: metadata.inputHeightPx - point.x,
            };
        case 180:
            return {
                x: metadata.inputWidthPx - point.x,
                y: metadata.inputHeightPx - point.y,
            };
        case 270:
            return {
                x: metadata.inputWidthPx - point.y,
                y: point.x,
            };
        default:
            return point;
    }
}

function mapBaseOutputToRawSource(
    metadata: INativePreviewOutputMetadata,
    point: IScanCleanupPixelPoint,
) {
    const rotated = metadata.inverseTransform
        ? applyPreviewAffine(metadata.inverseTransform, point)
        : metadata.dewarpMapping
            ? interpolateDewarpOutputToSource(metadata.dewarpMapping, point)
            : null;
    if (!rotated) {
        throw new Error('Scan cleanup base preview has no reusable detail geometry');
    }
    return inverseRotatePreviewPoint(rotated, metadata);
}

function resolveDetailRenderDpi(
    viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports'],
    outputs: IBasePreviewAnalysis['outputs'],
    requestedRenderDpi: number,
    baseDpi = PREVIEW_DPI,
) {
    let renderDpi = requestedRenderDpi;
    for (const half of [
        'full',
        'left',
        'right',
    ] as const) {
        const viewport = viewports[half];
        const metadata = outputs[half];
        if (!viewport || !metadata) continue;
        const visiblePixelsAtPreviewDpi = Math.max(
            1,
            metadata.outputWidthPx
                * metadata.outputHeightPx
                * viewport.widthNormalized
                * viewport.heightNormalized,
        );
        const budgetDpi = baseDpi * Math.sqrt(
            DETAIL_TILE_MAX_PIXELS * 0.98 / visiblePixelsAtPreviewDpi,
        );
        renderDpi = Math.min(renderDpi, budgetDpi);
    }
    return Math.max(1, Math.floor(renderDpi));
}

function resolveDetailViewport(
    viewport: IScanCleanupNormalizedRect,
    metadata: INativePreviewOutputMetadata,
    renderScale: number,
) {
    const targetWidth = metadata.outputWidthPx * renderScale;
    const targetHeight = metadata.outputHeightPx * renderScale;
    const left = Math.max(0, Math.floor(viewport.xNormalized * targetWidth));
    const top = Math.max(0, Math.floor(viewport.yNormalized * targetHeight));
    const right = Math.min(
        Math.round(targetWidth),
        Math.ceil((viewport.xNormalized + viewport.widthNormalized) * targetWidth),
    );
    const bottom = Math.min(
        Math.round(targetHeight),
        Math.ceil((viewport.yNormalized + viewport.heightNormalized) * targetHeight),
    );
    return {
        xPx: left,
        yPx: top,
        widthPx: Math.max(1, right - left),
        heightPx: Math.max(1, bottom - top),
    };
}

function resolveDetailSourceCrop(
    metadata: INativePreviewOutputMetadata,
    sampledRegion: IScanCleanupPreviewMetadata['sourceRegion'],
    renderScale: number,
    fullWidth: number,
    fullHeight: number,
) {
    const baseLeft = sampledRegion.xPx / renderScale;
    const baseTop = sampledRegion.yPx / renderScale;
    const baseRight = (sampledRegion.xPx + sampledRegion.widthPx) / renderScale;
    const baseBottom = (sampledRegion.yPx + sampledRegion.heightPx) / renderScale;
    const xSamples = [
        baseLeft,
        baseRight,
    ];
    const ySamples = [
        baseTop,
        baseBottom,
    ];
    const mapping = metadata.inverseTransform ? null : metadata.dewarpMapping;
    if (mapping) {
        for (let column = 1; column < mapping.columns - 1; column += 1) {
            const x = mapping.outputWidth * column / (mapping.columns - 1);
            if (x > baseLeft && x < baseRight) xSamples.push(x);
        }
        for (let row = 1; row < mapping.rows - 1; row += 1) {
            const y = mapping.outputHeight * row / (mapping.rows - 1);
            if (y > baseTop && y < baseBottom) ySamples.push(y);
        }
    }
    // An affine reaches its extrema at the rectangle corners. A bilinear
    // dewarp cell does too, so including every crossed grid boundary is exact.
    const points = xSamples.flatMap(x => ySamples.map(y => mapBaseOutputToRawSource(metadata, {
        x,
        y,
    })));
    const padding = 24;
    const left = Math.max(0, Math.floor(Math.min(...points.map(point => point.x)) * renderScale) - padding);
    const top = Math.max(0, Math.floor(Math.min(...points.map(point => point.y)) * renderScale) - padding);
    const right = Math.min(
        fullWidth,
        Math.ceil(Math.max(...points.map(point => point.x)) * renderScale) + padding,
    );
    const bottom = Math.min(
        fullHeight,
        Math.ceil(Math.max(...points.map(point => point.y)) * renderScale) + padding,
    );
    if (right <= left || bottom <= top) {
        throw new Error('Scan cleanup detail geometry resolved outside the source page');
    }
    return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    };
}

function readPngDimensions(bytes: Uint8Array, maxPixels = 45_000_000) {
    const signature = [
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
    ];
    if (bytes.byteLength < 24 || !signature.every((value, index) => bytes[index] === value)) {
        throw new Error('Scan cleanup preview produced an invalid PNG');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width < 1 || height < 1 || width * height > maxPixels) {
        throw new Error(`Scan cleanup preview PNG dimensions ${width}x${height} exceed limits`);
    }
    return {
        width,
        height,
    };
}

async function renderRasterToDisk(
    sourcePdfPath: string,
    pageNumber: number,
    outputPath: string,
    signal: AbortSignal,
    dependencies: IScanCleanupPreviewDependencies,
    renderDpi: number,
    maxPixels?: number,
    crop?: {
        x: number;
        y: number;
        width: number;
        height: number;
    },
    // PNG is the format of a raster something displays. A raster only the
    // sidecar reads is handed over raw, so nothing spends a second per page in
    // deflate for a pipe on this machine. Detection's rasters are retained as
    // the base preview's displayed original and stay PNG until that payload
    // stops being an <img> source; the tile crop is read by native only.
    format: 'png' | 'ppm' = 'png',
) {
    await (format === 'ppm' ? dependencies.renderPagePpm : dependencies.renderPage)(
        {pdftoppmBinary: dependencies.getPdftoppmBinary()},
        (level, message) => logger[level](message),
        pageNumber,
        sourcePdfPath,
        outputPath,
        renderDpi,
        undefined,
        signal,
        crop,
    );
    if (format === 'ppm') {
        const dimensions = await readPpmDimensions(outputPath);
        if (maxPixels !== undefined && dimensions.width * dimensions.height > maxPixels) {
            throw new Error(
                `Scan cleanup raster dimensions ${dimensions.width}x${dimensions.height} exceed limits`,
            );
        }
        return dimensions;
    }
    const handle = await open(outputPath, 'r');
    try {
        const header = Buffer.alloc(24);
        const {bytesRead} = await handle.read(header, 0, header.byteLength, 0);
        if (bytesRead !== header.byteLength) {
            throw new Error('Scan cleanup raster produced a truncated PNG');
        }
        return readPngDimensions(header, maxPixels);
    } finally {
        await handle.close();
    }
}

async function readPreviewBytes(path: string) {
    const file = await stat(path);
    if (file.size < 1 || file.size > PREVIEW_MAX_IMAGE_BYTES) {
        throw new Error(`Scan cleanup preview image exceeds ${PREVIEW_MAX_IMAGE_BYTES} bytes`);
    }
    const bytes = new Uint8Array(await readFile(path));
    readPngDimensions(bytes);
    return bytes;
}

async function runDetailPreview(
    request: IScanCleanupPreviewRequest & {detail: NonNullable<IScanCleanupPreviewRequest['detail']>},
    signal: AbortSignal,
    baseRaw: IRawPreview,
    baseRasterPath: string,
    analysis: IBasePreviewAnalysis,
    scratch: string,
    dependencies: IScanCleanupPreviewDependencies,
): Promise<IScanCleanupPreviewResult> {
    const sourceDpiCandidate = await dependencies.detectSourceDpi?.(
        request.sourcePdfPath,
        request.pageNumber,
        signal,
    );
    const sourceDpiDetected = sourceDpiCandidate !== null
        && sourceDpiCandidate !== undefined
        && Number.isFinite(sourceDpiCandidate)
        && sourceDpiCandidate > 0;
    const sourceDpi = sourceDpiDetected ? Number(sourceDpiCandidate) : DEFAULT_SOURCE_DPI;
    const requestedRenderDpi = request.detail.outputMode === 'bw'
        ? sourceDpiDetected ? sourceDpi : Math.max(sourceDpi, 600)
        : Math.max(sourceDpi, baseRaw.dpi);
    const renderDpi = resolveDetailRenderDpi(
        request.detail.viewports,
        analysis.outputs,
        requestedRenderDpi,
        baseRaw.dpi,
    );
    if (renderDpi <= baseRaw.dpi) {
        return {
            pageNumber: request.pageNumber,
            totalPages: baseRaw.totalPages,
            rawImageData: baseRaw.bytes,
            rawWidthPx: baseRaw.width,
            rawHeightPx: baseRaw.height,
            pageMetadata: analysis.pageMetadata,
            outputs: [],
        };
    }
    const renderScale = renderDpi / baseRaw.dpi;
    const fullSourceWidth = Math.max(1, Math.round(baseRaw.width * renderScale));
    const fullSourceHeight = Math.max(1, Math.round(baseRaw.height * renderScale));
    const maxSourcePixels = resolveScanCleanupPipelineMaxPixels(request.detail.outputMode);
    const binary = dependencies.resolveBinary();
    if (!binary) throw new Error('Scan cleanup native tool is unavailable');

    const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, request.pageNumber);
    const effectiveOptions = request.options.matchPageSize
        ? {
            ...request.options,
            matchPageSize: false,
        }
        : request.options;
    const pageInputs = [];
    const outputFiles: Array<{
        outputPath: string;
        metadataPath: string;
    }> = [];
    for (const half of [
        'full',
        'left',
        'right',
    ] as const) {
        const viewport = request.detail.viewports[half];
        const baseMetadata = analysis.outputs[half];
        if (!viewport || !baseMetadata) continue;
        if (viewport.rotationDegrees !== pageOverride.rotationDegrees) {
            throw new Error('Scan cleanup detail viewport rotation is stale');
        }
        const renderRegion = resolveDetailViewport(
            viewport,
            baseMetadata,
            renderScale,
        );
        const outputWidth = Math.max(1, Math.round(baseMetadata.outputWidthPx * renderScale));
        const outputHeight = Math.max(1, Math.round(baseMetadata.outputHeightPx * renderScale));
        const processingApron = request.detail.outputMode === 'bw' || request.detail.outputMode === 'mixed'
            ? 256
            : 8;
        const sampledRegion = {
            xPx: Math.max(0, renderRegion.xPx - processingApron),
            yPx: Math.max(0, renderRegion.yPx - processingApron),
            widthPx: 0,
            heightPx: 0,
        };
        const sampledRight = Math.min(
            outputWidth,
            renderRegion.xPx + renderRegion.widthPx + processingApron,
        );
        const sampledBottom = Math.min(
            outputHeight,
            renderRegion.yPx + renderRegion.heightPx + processingApron,
        );
        sampledRegion.widthPx = sampledRight - sampledRegion.xPx;
        sampledRegion.heightPx = sampledBottom - sampledRegion.yPx;
        const sourceCrop = resolveDetailSourceCrop(
            baseMetadata,
            sampledRegion,
            renderScale,
            fullSourceWidth,
            fullSourceHeight,
        );
        if (
            sourceCrop.width > 40_000
            || sourceCrop.height > 40_000
            || sourceCrop.width * sourceCrop.height > maxSourcePixels
        ) {
            throw new Error(
                `Scan cleanup detail source crop ${sourceCrop.width}x${sourceCrop.height} exceeds native limits`,
            );
        }
        // The tile crop is the sidecar's input and nothing else reads it, so it
        // takes the same handoff the final run takes: raw when the crop fits the
        // scratch budget, PNG when it does not.
        const handoff = await resolveRasterHandoff([{
            renderDpi,
            raster: {
                dpi: renderDpi,
                width: sourceCrop.width,
                height: sourceCrop.height,
            },
        }], scratch, readAvailableScratchBytes);
        logRasterHandoff((level, message) => logger[level](message), 'detail tile', handoff);
        const inputPath = join(scratch, `detail-source-${half}.${handoff.format}`);
        const renderedSource = await renderRasterToDisk(
            request.sourcePdfPath,
            request.pageNumber,
            inputPath,
            signal,
            dependencies,
            renderDpi,
            maxSourcePixels,
            sourceCrop,
            handoff.format,
        );
        // Poppler clips -W/-H at the physical page edge. The 150-DPI base
        // dimensions can round up by a few scaled pixels, so trust the actual
        // cropped raster dimensions passed to native.
        sourceCrop.width = renderedSource.width;
        sourceCrop.height = renderedSource.height;
        const baseMetadataPath = join(scratch, `base-metadata-${half}.json`);
        await writeFile(baseMetadataPath, JSON.stringify(baseMetadata));
        const canonicalRaster = analysis.canonicalRasters[half];
        if (!canonicalRaster) {
            throw new Error(`Scan cleanup detail has no canonical ${half} base raster`);
        }
        const baseCleanedRasterPath = join(scratch, `base-cleaned-${half}.png`);
        await writeFile(baseCleanedRasterPath, canonicalRaster);
        const output = {
            outputPath: join(scratch, `detail-clean-${half}.png`),
            metadataPath: join(scratch, `detail-clean-${half}.json`),
        };
        outputFiles.push(output);
        pageInputs.push({
            inputPath,
            pageNumber: request.pageNumber,
            dpi: renderDpi,
            sourceDpi,
            requestedRenderDpi,
            resolvedOutputMode: request.detail.outputMode,
            pageMetadataPath: join(scratch, `detail-page-${half}.json`),
            outputs: [output],
            detailRenderPlan: {
                baseMetadataPath,
                baseRasterPath,
                baseCleanedRasterPath,
                sourceCrop: {
                    xPx: sourceCrop.x,
                    yPx: sourceCrop.y,
                    widthPx: sourceCrop.width,
                    heightPx: sourceCrop.height,
                },
                fullSourceWidthPx: fullSourceWidth,
                fullSourceHeightPx: fullSourceHeight,
                scale: renderScale,
                renderRegion,
                sampledRegion,
            },
        });
    }
    if (pageInputs.length === 0) {
        throw new Error('Scan cleanup detail request has no matching base output');
    }
    const manifest = buildNativeScanCleanupManifest({
        operation: 'render',
        renderMode: 'preview',
        canvasScope: 'page',
        qualityPath: 'raster',
        options: effectiveOptions,
        experimental: {autoDewarp: false},
        pages: pageInputs,
    });
    const manifestPath = join(scratch, 'detail-manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await dependencies.runSidecar(
        binary,
        manifestPath,
        signal,
        (level, message) => logger[level](message),
        () => undefined,
    );
    const cleaned = [] as IScanCleanupPreviewResult['outputs'];
    for (const output of outputFiles) {
        const nativeMetadata = JSON.parse(
            await readFile(output.metadataPath, 'utf8'),
        ) as INativePreviewOutputMetadata;
        cleaned.push({
            imageData: await readPreviewBytes(output.outputPath),
            metadata: {
                ...nativeMetadata,
                ...(nativeMetadata.dewarpModel === undefined
                    ? {}
                    : {dewarpApplied: nativeMetadata.dewarpModel !== null}),
            },
        });
    }
    return {
        pageNumber: request.pageNumber,
        totalPages: baseRaw.totalPages,
        rawImageData: baseRaw.bytes,
        rawWidthPx: baseRaw.width,
        rawHeightPx: baseRaw.height,
        pageMetadata: analysis.pageMetadata,
        outputs: cleaned,
    };
}

async function runPreview(
    request: IScanCleanupPreviewRequest,
    signal: AbortSignal,
    retention: TRawRasterRetention,
    baseAnalysisCache: Map<string, IBasePreviewAnalysis>,
    dependencies: IScanCleanupPreviewDependencies,
    emitRawRaster: (raw: IScanCleanupRawPreviewEvent) => void,
): Promise<TScanCleanupPreviewWireResult> {
    if (!isAbsolute(request.sourcePdfPath)) throw new Error('Scan cleanup preview requires an absolute source path');
    if (signal.aborted) throw signal.reason;
    const document = await retention.openDocument(request);
    // Created after the document is open, so a failed open does not leave a
    // scratch directory behind with nothing to remove it.
    const scratch = await mkdtemp(join(dependencies.getTempDir(), 'scan-cleanup-preview-'))
        .catch(async (error: unknown) => {
            await retention.release(document);
            throw error;
        });
    try {
        // A scan whose embedded pixels are described as PDF points is a
        // 72-DPI source, not a reason to synthesize a 100-megapixel "150-DPI
        // preview". Page metadata answers without decoding the page and also
        // gives matching its document-wide grid. Only lower the preview grid
        // when every page is proven to be a full-page raster; mixed/vector
        // documents keep the conservative 150-DPI preview.
        const previewWarnings: string[] = [];
        let pageSizes: IPdfPageSize[] | null = null;
        let previewRasterPlan = resolvePreviewRasterPlan(null);
        try {
            pageSizes = await retention.pageSizes(document, signal);
            previewRasterPlan = resolvePreviewRasterPlan(pageSizes);
        } catch (error) {
            if (signal.aborted) throw error;
            if (request.options.matchPageSize) {
                const detail = getErrorMessage(error);
                previewWarnings.push(
                    'Matched page size is off for this document: its page geometry could not be measured '
                    + `(${detail}). Pages are previewed and cleaned at their own size.`,
                );
                logger.warn(`Scan cleanup preview dropped matched page size: ${detail}`);
            } else {
                logger.debug(
                    `Scan cleanup preview kept the 150-DPI geometry fallback: ${getErrorMessage(error)}`,
                );
            }
        }
        if (!request.options.matchPageSize) {
            const sourceDpiCandidate = await dependencies.detectSourceDpi?.(
                request.sourcePdfPath,
                request.pageNumber,
                signal,
            );
            if (
                sourceDpiCandidate !== null
                && sourceDpiCandidate !== undefined
                && Number.isFinite(sourceDpiCandidate)
                && sourceDpiCandidate > 0
            ) {
                const dpi = Math.min(PREVIEW_DPI, sourceDpiCandidate);
                const pageSize = pageSizes?.find(page => page.pageNumber === request.pageNumber);
                const renderDpi = pageSize === undefined
                    ? dpi
                    : resolvePagePreviewDpi(pageSize, dpi);
                previewRasterPlan = {
                    dpi,
                    detectionDpiByPageNumber: new Map([[
                        request.pageNumber,
                        Math.min(DETECTION_DPI, renderDpi),
                    ]]),
                    pageDpiByNumber: new Map([[
                        request.pageNumber,
                        sourceDpiCandidate,
                    ]]),
                    renderDpiByPageNumber: new Map([[
                        request.pageNumber,
                        renderDpi,
                    ]]),
                };
            }
        }
        const basePreviewDpi = previewRasterPlan.renderDpiByPageNumber.get(request.pageNumber)
            ?? previewRasterPlan.dpi;
        const baseRaw = await materializeRawRaster(
            document,
            request.pageNumber,
            signal,
            retention,
            dependencies,
            undefined,
            basePreviewDpi,
        );
        // A base preview pushes its raster the moment it exists — a whole
        // sidecar run ahead of the cleaned outputs — and then leaves those
        // bytes out of its result, because the renderer already holds them.
        // A detail tile renders from geometry the base run established and
        // still answers with the raster its caller keyed the tile against.
        const streamedRaw = request.detail === undefined;
        if (streamedRaw) {
            emitRawRaster({
                ownerId: request.ownerId,
                documentRevision: request.documentRevision,
                requestId: request.requestId,
                pageNumber: request.pageNumber,
                totalPages: baseRaw.totalPages,
                rawImageData: baseRaw.bytes,
                rawWidthPx: baseRaw.width,
                rawHeightPx: baseRaw.height,
            });
        }
        const rawImage = streamedRaw ? {} : {rawImageData: baseRaw.bytes};
        // Measured from the document's own geometry and the layouts the caller
        // has observed, at the resolution the preview renders with: every
        // matched page of this session is presented on one rectangle and one
        // pixel grid — the same rectangle the final run writes, from the same
        // inputs, at its own resolution — from the first page of a cold session
        // onwards.
        //
        // Geometry is what matching needs, and nothing else about cleaning a
        // page depends on it. A document no tool here can measure therefore
        // previews with matching dropped and says so, rather than answering a
        // page the user asked to clean with an error about page sizes.
        const documentCanvas = pageSizes && request.options.matchPageSize
            ? resolveScanCleanupDocumentCanvas(
                pageSizes,
                basePreviewDpi,
                request.options,
                request.layoutByPage,
            )
            : null;
        let inputPath = baseRaw.path;
        let renderDpi = basePreviewDpi;
        let requestedRenderDpi = basePreviewDpi;
        let sourceDpi = previewRasterPlan.pageDpiByNumber.get(request.pageNumber)
            ?? previewRasterPlan.dpi;
        let fallbackDetail = false;
        if (request.detail) {
            const {
                detail: _detail,
                ...baseRequest
            } = request;
            const analysis = baseAnalysisCache.get(baseAnalysisKey(baseRequest, documentCanvas));
            if (
                !analysis
                || analysis.mtimeMs !== baseRaw.document.mtimeMs
                || (
                    request.detail.outputMode !== 'mixed'
                    && analysis.outputMode !== request.detail.outputMode
                )
            ) {
                throw new Error(
                    'Scan cleanup detail geometry is unavailable; rebuild the base preview'
                    + ` (base mode ${analysis?.outputMode ?? 'unknown'}, detail ${JSON.stringify(request.detail)})`,
                );
            }
            const detailRequest = request as IScanCleanupPreviewRequest & {detail: NonNullable<IScanCleanupPreviewRequest['detail']>;};
            const pageOverride = getScanCleanupPageOverride(
                request.options.pageOverrides,
                request.pageNumber,
            );
            const hasManualZones = (pageOverride.manualZones?.picture.length ?? 0) > 0
                || (pageOverride.manualZones?.fill.length ?? 0) > 0;
            if (request.detail.outputMode !== 'mixed' && !hasManualZones) {
                return await runDetailPreview(
                    detailRequest,
                    signal,
                    baseRaw,
                    inputPath,
                    analysis,
                    scratch,
                    dependencies,
                );
            }
            fallbackDetail = true;
            const sourceDpiCandidate = await dependencies.detectSourceDpi?.(
                request.sourcePdfPath,
                request.pageNumber,
                signal,
            );
            sourceDpi = sourceDpiCandidate !== null
                && sourceDpiCandidate !== undefined
                && Number.isFinite(sourceDpiCandidate)
                && sourceDpiCandidate > 0
                ? sourceDpiCandidate
                : DEFAULT_SOURCE_DPI;
            ({
                renderDpi,
                requestedRenderDpi,
            } = resolveFallbackDetailDpi(detailRequest, baseRaw, sourceDpi, documentCanvas));
            if (renderDpi !== baseRaw.dpi) {
                ({path: inputPath} = await materializeRawRaster(
                    document,
                    request.pageNumber,
                    signal,
                    retention,
                    dependencies,
                    baseRaw.totalPages,
                    renderDpi,
                ));
            }
        }
        if (signal.aborted) throw signal.reason;
        const binary = dependencies.resolveBinary();
        if (!binary) throw new Error('Scan cleanup native tool is unavailable');
        const outputs = [
            0,
            1,
        ].map(index => ({
            outputPath: join(scratch, `clean-${index}.png`),
            metadataPath: join(scratch, `clean-${index}.json`),
        }));
        const manifestPath = join(scratch, 'manifest.json');
        const pageMetadataPath = join(scratch, 'page.json');
        const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, request.pageNumber);
        const sourceRasterStructure = await retention.rasterPages(document, signal);
        // Matching a document onto one rectangle also means one pixel grid, and
        // the lossless assembler cannot give a page that carries its own raster
        // the document's grid without resampling it. Where the two collide the
        // final run renders the whole document — so this preview renders it too,
        // rather than presenting the untouched page a lossless run would have
        // produced and calling it what the user will get.
        const rasterPages = request.options.preserveOriginalQuality === true && pageSizes?.length
            ? await retention.rasterPages(document, signal)
            : null;
        const rasterizedByMatching = pageSizes !== null
            && rasterPages !== null
            && resolveMatchedCanvasResamplePages(
                pageSizes,
                pageSizes.map(pageSize => pageSize.pageNumber),
                request.options,
                SCAN_CLEANUP_LOSSLESS_CANVAS_GRID_DPI,
                rasterPages.pages,
                rasterPages.detected,
                request.layoutByPage,
            ).length > 0;
        const lossless = request.options.preserveOriginalQuality === true && !rasterizedByMatching;
        // Every detail request that reaches this far fell back to a full
        // render, so this is the base render's canvas in both cases.
        const matchedCanvas = documentCanvas ?? undefined;
        const effectiveOptions = (matchedCanvas === undefined && request.options.matchPageSize)
            ? {
                ...request.options,
                matchPageSize: false,
            }
            : request.options;
        const sourceBackgroundDpi = sourceRasterStructure.backgroundDpiByPage?.get(request.pageNumber);
        let trustedMrcLayers: IPdfMrcLayers | null = null;
        if (
            request.options.outputMode === 'auto'
            && request.options.thickness === 0
            && request.options.autoDewarp !== true
            && pageOverride.outputModeOverride === undefined
            && pageOverride.rotationDegrees === 0
            && (pageOverride.manualZones?.picture.length ?? 0) === 0
            && (pageOverride.manualZones?.fill.length ?? 0) === 0
            && sourceRasterStructure.bilevelLayerPages?.has(request.pageNumber) === true
            && dependencies.extractMrcLayers !== undefined
        ) {
            const extractionStartedAt = performance.now();
            try {
                trustedMrcLayers = await dependencies.extractMrcLayers(
                    document.sourcePdfPath,
                    request.pageNumber,
                    join(scratch, 'source-mrc-selection.png'),
                    join(scratch, 'source-mrc-background.png'),
                    signal,
                    (level, message) => logger[level](message),
                );
                logger.debug(
                    `Scan cleanup preview source-layer extraction page ${String(request.pageNumber)} `
                    + `reused=${String(trustedMrcLayers !== null)} `
                    + `durationMs=${(performance.now() - extractionStartedAt).toFixed(0)}`,
                );
            } catch (error) {
                // Cancellation is not evidence that this page lacks reusable
                // layers. Falling through started an ordinary raster cleanup
                // for a request the renderer had already superseded, leaving a
                // gray raw frame visible under the selected Cleaned tab.
                signal.throwIfAborted();
                logger.warn(
                    `Scan cleanup preview could not reuse page ${String(request.pageNumber)}'s `
                    + `compact MRC foreground; using raster reconstruction (${getErrorMessage(error)})`,
                );
            }
        }
        const manifest = buildNativeScanCleanupManifest({
            operation: lossless ? 'analyze' : 'render',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: lossless ? 'lossless' : 'raster',
            options: effectiveOptions,
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined
                    ? {}
                    : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            ...(matchedCanvas === undefined ? {} : {documentCanvas: matchedCanvas}),
            pages: [{
                inputPath,
                ...(trustedMrcLayers === null
                    ? {}
                    : {
                        trustedForegroundMaskPath: trustedMrcLayers.selectionMaskPath,
                        trustedMrcBackgroundPath: trustedMrcLayers.backgroundPath,
                    }),
                pageNumber: request.pageNumber,
                dpi: renderDpi,
                sourceDpi,
                sourceHasBilevelLayer: sourceRasterStructure.bilevelLayerPages
                    ?.has(request.pageNumber) ?? false,
                ...(sourceBackgroundDpi === undefined ? {} : {sourceBackgroundDpi}),
                requestedRenderDpi,
                ...(request.detail === undefined
                    ? (request.outputModeRecommendation === undefined
                        ? {}
                        : {resolvedOutputMode: request.outputModeRecommendation})
                    : {resolvedOutputMode: request.detail.outputMode}),
                ...(request.softAlphaForegroundRecommendation === undefined
                    ? {}
                    : {preferSoftAlphaForeground: request.softAlphaForegroundRecommendation}),
                ...(request.layoutByPage?.[String(request.pageNumber)] === undefined
                    ? {}
                    : {observedLayout: request.layoutByPage[String(request.pageNumber)]}),
                pageMetadataPath,
                outputs,
                ...(request.documentPrior === undefined ? {} : {documentPrior: request.documentPrior}),
            }],
        });
        await writeFile(manifestPath, JSON.stringify(manifest));
        await dependencies.runSidecar(binary, manifestPath, signal, (level, message) => logger[level](message), () => undefined);
        const pageMetadata = JSON.parse(await readFile(pageMetadataPath, 'utf8')) as ILosslessPreviewPageMetadata;
        if (lossless) {
            const analyzedOutputs = pageMetadata.outputs ?? [];
            // The plan already carries the grid it was measured on, so a
            // preview at that resolution reports the plan's own pixels rather
            // than a second rounding of them.
            const canvasGridScale = renderDpi / baseRaw.dpi;
            const canvasWidthPx = matchedCanvas === undefined
                ? null
                : Math.max(1, Math.round(matchedCanvas.widthPx * canvasGridScale));
            const canvasHeightPx = matchedCanvas === undefined
                ? null
                : Math.max(1, Math.round(matchedCanvas.heightPx * canvasGridScale));
            return {
                pageNumber: request.pageNumber,
                totalPages: baseRaw.totalPages,
                ...rawImage,
                rawWidthPx: baseRaw.width,
                rawHeightPx: baseRaw.height,
                pageMetadata: {
                    ...pageMetadata,
                    outputDiagnostics: analyzedOutputs.map(output => ({
                        half: output.half,
                        ...(output.contentDiagnostics === undefined
                            ? {}
                            : {contentDiagnostics: output.contentDiagnostics}),
                        ...(output.textToneDiagnostics === undefined
                            ? {}
                            : {textToneDiagnostics: output.textToneDiagnostics}),
                    })),
                },
                outputs: analyzedOutputs.map(output => {
                    const outputWidthPx = Math.max(1, Math.round(output.cropRect.widthPx));
                    const outputHeightPx = Math.max(1, Math.round(output.cropRect.heightPx));
                    // The canvas is strict: it already contains every page's
                    // content and margins, measured document-wide before this
                    // page was rendered, so growing it here for one output
                    // would be the per-page frame drift it exists to prevent.
                    const resolvedCanvasWidth = canvasWidthPx ?? outputWidthPx;
                    const resolvedCanvasHeight = canvasHeightPx ?? outputHeightPx;
                    // The assembler scales this output's own objects from the
                    // paper it was cut from onto the canvas, so the preview
                    // presents it at the same scale. Measuring from the paper
                    // and not from the cropped content is what makes a spread
                    // half and a page scanned on its own land the same size.
                    const paperScale = canvasWidthPx === null || canvasHeightPx === null
                        ? 1
                        : resolveScanCleanupCanvasFitScale({
                            widthPoints: canvasWidthPx,
                            heightPoints: canvasHeightPx,
                        }, {
                            widthPoints: Math.max(1, output.sourceRegion.widthPx),
                            heightPoints: Math.max(1, output.sourceRegion.heightPx),
                        });
                    // Margins laid around cropped content can ask for more room
                    // than the paper the scale was measured on. The rectangle
                    // does not grow, so the page is fitted inside it whole — the
                    // same policy the raster path applies, reported the same way
                    // — rather than having its margins clipped at the box edge.
                    const contentScale = paperScale * Math.min(1, resolveScanCleanupCanvasFitScale({
                        widthPoints: resolvedCanvasWidth,
                        heightPoints: resolvedCanvasHeight,
                    }, {
                        widthPoints: Math.max(1, outputWidthPx * paperScale),
                        heightPoints: Math.max(1, outputHeightPx * paperScale),
                    }));
                    const contentWidthPx = Math.min(
                        resolvedCanvasWidth,
                        Math.max(1, Math.round(outputWidthPx * contentScale)),
                    );
                    const contentHeightPx = Math.min(
                        resolvedCanvasHeight,
                        Math.max(1, Math.round(outputHeightPx * contentScale)),
                    );
                    const canvasOverflow = contentScale < paperScale * (1 - CANVAS_CONTENT_SCALE_EPSILON);
                    const placement = resolveScanCleanupPlacementOffset(
                        resolvedCanvasWidth - contentWidthPx,
                        resolvedCanvasHeight - contentHeightPx,
                        pageOverride.placementOverrides?.[output.half] ?? request.options.pageAlignment,
                    );
                    return {
                        imageData: baseRaw.bytes,
                        metadata: {
                            half: output.half,
                            layoutClassification: pageMetadata.layoutClassification,
                            layoutConfidence: pageMetadata.layoutConfidence ?? 0,
                            sourceRegion: output.sourceRegion,
                            contentBox: output.contentBox,
                            cropRect: output.cropRect,
                            ...(output.contentDiagnostics === undefined
                                ? {}
                                : {contentDiagnostics: output.contentDiagnostics}),
                            appliedMargins: output.appliedMargins,
                            outputWidthPx,
                            outputHeightPx,
                            canvasWidthPx: resolvedCanvasWidth,
                            canvasHeightPx: resolvedCanvasHeight,
                            placementOffsetXPx: placement.x,
                            placementOffsetYPx: placement.y,
                            forwardTransform: null,
                            cutterXPx: pageMetadata.cutterXPx,
                            inputWidthPx: output.inputWidthPx,
                            inputHeightPx: output.inputHeightPx,
                            rotationDegrees: pageMetadata.rotationDegrees,
                            canvasScope: 'page',
                            resamplePasses: 0,
                            sourceDpi,
                            renderDpi,
                            requestedRenderDpi,
                            rasterScaleLimited: false,
                            canvasPolicy: matchedCanvas === undefined ? 'intrinsic' : 'strict-maximum',
                            canvasOverflow,
                            matchedCanvasTargetWidthPx: canvasWidthPx,
                            matchedCanvasTargetHeightPx: canvasHeightPx,
                            matchedCanvasTargetWidthPoints: matchedCanvas?.widthPoints ?? null,
                            matchedCanvasTargetHeightPoints: matchedCanvas?.heightPoints ?? null,
                            // A lossless run hands the original page objects to
                            // the assembler, which scales them onto the canvas
                            // without resampling them: the content changes size
                            // with the sheet, and the renderer presents it at
                            // exactly the size the output page will carry.
                            matchedCanvasContentWidthPx: contentWidthPx,
                            matchedCanvasContentHeightPx: contentHeightPx,
                            warnings: [
                                ...previewWarnings,
                                ...(canvasOverflow
                                    ? [`Matched page size fitted this page to ${String(contentWidthPx)}x${String(contentHeightPx)} px `
                                        + `inside the ${String(resolvedCanvasWidth)}x${String(resolvedCanvasHeight)} px document canvas, `
                                        + 'below the document\'s scale']
                                    : []),
                            ],
                        },
                    };
                }),
            };
        }
        const cleaned = [] as IScanCleanupPreviewResult['outputs'];
        const nativeOutputs: IBasePreviewAnalysis['outputs'] = {};
        const canonicalRasters: IBasePreviewAnalysis['canonicalRasters'] = {};
        let canonicalRasterBytes = 0;
        for (const output of outputs) {
            try {
                const nativeMetadata = JSON.parse(
                    await readFile(output.metadataPath, 'utf8'),
                ) as INativePreviewOutputMetadata;
                nativeOutputs[nativeMetadata.half] = nativeMetadata;
                const imageData = await readPreviewBytes(output.outputPath);
                canonicalRasters[nativeMetadata.half] = imageData;
                canonicalRasterBytes += imageData.byteLength;
                cleaned.push({
                    imageData,
                    metadata: {
                        ...nativeMetadata,
                        ...(nativeMetadata.dewarpModel === undefined
                            ? {}
                            : {dewarpApplied: nativeMetadata.dewarpModel !== null}),
                        // What Electron decided before the render — matching
                        // dropped for want of geometry — belongs beside what
                        // the engine reported about the page itself.
                        warnings: [
                            ...previewWarnings,
                            ...nativeMetadata.warnings ?? [],
                        ],
                    },
                });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
        const diagnosticMetadata = cleaned[0]?.metadata;
        const result: TScanCleanupPreviewWireResult = {
            pageNumber: request.pageNumber,
            totalPages: baseRaw.totalPages,
            ...rawImage,
            rawWidthPx: baseRaw.width,
            rawHeightPx: baseRaw.height,
            pageMetadata: {
                ...pageMetadata,
                ...(diagnosticMetadata?.detectedSkewDegrees === undefined
                    ? {}
                    : {detectedSkewDegrees: diagnosticMetadata.detectedSkewDegrees}),
                ...(diagnosticMetadata?.skewConfidence === undefined
                    ? {}
                    : {skewConfidence: diagnosticMetadata.skewConfidence}),
                ...(diagnosticMetadata?.manualSkew === undefined
                    ? {}
                    : {manualSkew: diagnosticMetadata.manualSkew}),
                ...(diagnosticMetadata?.binarizationMode === undefined
                    ? {}
                    : {binarizationMode: diagnosticMetadata.binarizationMode}),
                ...(diagnosticMetadata?.binarizationDiagnostics === undefined
                    ? {}
                    : {binarizationDiagnostics: diagnosticMetadata.binarizationDiagnostics}),
                ...(diagnosticMetadata?.textToneDiagnostics === undefined
                    ? {}
                    : {textToneDiagnostics: diagnosticMetadata.textToneDiagnostics}),
                ...(diagnosticMetadata?.despeckleFallback === undefined
                    ? {}
                    : {despeckleFallback: diagnosticMetadata.despeckleFallback}),
                ...(diagnosticMetadata?.dewarpConfidence === undefined
                    ? {}
                    : {dewarpConfidence: diagnosticMetadata.dewarpConfidence}),
                ...(diagnosticMetadata?.dewarpApplied === undefined
                    ? {}
                    : {dewarpApplied: diagnosticMetadata.dewarpApplied}),
                outputDiagnostics: cleaned.map(output => ({
                    half: output.metadata.half,
                    ...(output.metadata.contentDiagnostics === undefined
                        ? {}
                        : {contentDiagnostics: output.metadata.contentDiagnostics}),
                    ...(output.metadata.textToneDiagnostics === undefined
                        ? {}
                        : {textToneDiagnostics: output.metadata.textToneDiagnostics}),
                })),
                autoDewarpAttempted: request.options.autoDewarp === true,
            },
            outputs: cleaned,
        };
        if (!fallbackDetail) {
            signal.throwIfAborted();
            const analysisKey = baseAnalysisKey(request, documentCanvas);
            baseAnalysisCache.delete(analysisKey);
            baseAnalysisCache.set(analysisKey, {
                sourcePdfPath: request.sourcePdfPath,
                documentRevision: request.documentRevision,
                mtimeMs: baseRaw.document.mtimeMs,
                ...(result.outputs[0]?.metadata.outputMode === undefined
                    ? {}
                    : {outputMode: result.outputs[0].metadata.outputMode}),
                pageMetadata: result.pageMetadata,
                outputs: nativeOutputs,
                canonicalRasters,
                canonicalRasterBytes,
            });
            pruneBaseAnalysisCache(baseAnalysisCache);
        }
        return result;
    } finally {
        await retention.release(document);
        await rm(scratch, {
            recursive: true,
            force: true,
        });
    }
}

async function mapDetectionPages<T>(
    pages: readonly number[],
    task: (pageNumber: number) => Promise<T>,
    onCompleted?: (pageNumber: number, completedPages: number) => void,
    concurrency = resolveScanCleanupRasterConcurrency(),
) {
    const results = new Array<T>(pages.length);
    let nextIndex = 0;
    let completedPages = 0;
    const workers = Array.from({length: Math.min(concurrency, pages.length)}, async () => {
        while (nextIndex < pages.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await task(pages[index]!);
            completedPages += 1;
            onCompleted?.(pages[index]!, completedPages);
        }
    });
    const settled = await Promise.allSettled(workers);
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    return results;
}

function normalizeDetectionContentBox(
    output: INativeScanCleanupAnalysisOutputV3,
    rotationDegrees: IScanCleanupPagePlanEvidence['rotationDegrees'],
) {
    const contentBox = output.contentBox;
    if (
        contentBox === null
        || contentBox === undefined
        || output.inputWidthPx <= 0
        || output.inputHeightPx <= 0
        || output.sourceRegion.widthPx <= 0
        || output.sourceRegion.heightPx <= 0
    ) {
        return undefined;
    }
    const analysisWidth = rotationDegrees === 90 || rotationDegrees === 270
        ? output.inputHeightPx
        : output.inputWidthPx;
    const analysisHeight = rotationDegrees === 90 || rotationDegrees === 270
        ? output.inputWidthPx
        : output.inputHeightPx;
    const left = Math.max(0, Math.min(output.sourceRegion.widthPx, contentBox.xPx));
    const top = Math.max(0, Math.min(output.sourceRegion.heightPx, contentBox.yPx));
    const right = Math.max(
        left,
        Math.min(output.sourceRegion.widthPx, contentBox.xPx + contentBox.widthPx),
    );
    const bottom = Math.max(
        top,
        Math.min(output.sourceRegion.heightPx, contentBox.yPx + contentBox.heightPx),
    );
    if (right <= left || bottom <= top) {
        return undefined;
    }
    // Content coordinates are local to the output half, while their scale is
    // the complete rotated analysis page. Normalize the two edges first and
    // derive the extent from them. Besides documenting that mixed coordinate
    // space, this makes a box that ends at the page edge serialize as
    // `1 - start` instead of two independently rounded quotients whose sum can
    // become 1.0000000000000002 and fail the final native manifest validator.
    const leftNormalized = left / analysisWidth;
    const topNormalized = top / analysisHeight;
    const rightNormalized = right === analysisWidth ? 1 : right / analysisWidth;
    const bottomNormalized = bottom === analysisHeight ? 1 : bottom / analysisHeight;
    return {
        xNormalized: leftNormalized,
        yNormalized: topNormalized,
        widthNormalized: rightNormalized - leftNormalized,
        heightNormalized: bottomNormalized - topNormalized,
        rotationDegrees,
    };
}

function createDetectionPagePlanEvidence(
    result: IScanCleanupDetectionResult,
    metadata: INativeScanCleanupPageMetadataV3,
    includeContentBoxes: boolean,
): IScanCleanupPagePlanEvidence {
    const rotationDegrees = metadata.rotationDegrees;
    const firstOutput = metadata.outputs?.[0];
    const analysisWidth = firstOutput === undefined
        ? 0
        : rotationDegrees === 90 || rotationDegrees === 270
            ? firstOutput.inputHeightPx
            : firstOutput.inputWidthPx;
    const splitXNormalized = result.cutterXPx === null || analysisWidth <= 0
        ? undefined
        : result.cutterXPx / analysisWidth;
    const automaticSplit = splitXNormalized === undefined
        || splitXNormalized <= 0
        || splitXNormalized >= 1
        ? undefined
        : {
            xNormalized: splitXNormalized,
            rotationDegrees,
        };
    const outputs: IScanCleanupPagePlanEvidence['outputs'] = {};
    for (const output of metadata.outputs ?? []) {
        const contentBox = includeContentBoxes
            ? normalizeDetectionContentBox(output, rotationDegrees)
            : undefined;
        if (contentBox === undefined && output.textToneDiagnostics === undefined) {
            continue;
        }
        outputs[output.half] = {
            ...(contentBox === undefined ? {} : {contentBox}),
            ...(output.textToneDiagnostics === undefined
                ? {}
                : {textToneDiagnostics: output.textToneDiagnostics}),
        };
    }
    return {
        pageNumber: result.pageNumber,
        rotationDegrees,
        layoutClassification: result.classification,
        ...(automaticSplit === undefined ? {} : {automaticSplit}),
        outputs,
    };
}

async function runDetection(
    request: IScanCleanupDetectionRequest,
    signal: AbortSignal,
    retention: TRawRasterRetention,
    dependencies: IScanCleanupPreviewDependencies,
    publish: (results: IScanCleanupDetectionResult[], progress: TScanCleanupProgress) => void,
) {
    // The document opens first: a scratch directory created before it has
    // nothing to release it if opening throws, and the only thing that ever
    // removed it was this function's own success path.
    const document = await retention.openDocument(request);
    let scratchDir: string | null = null;
    try {
        const scratch = await mkdtemp(join(dependencies.getTempDir(), 'scan-cleanup-detect-'));
        scratchDir = scratch;
        const totalPages = await retention.pageCount(document, signal);
        const pageNumbers = Array.from({length: totalPages}, (_, index) => index + 1);
        const pageSizes = await retention.pageSizes(document, signal).catch(error => {
            if (signal.aborted) throw error;
            logger.debug(
                `Scan cleanup detection kept the 150-DPI fallback: ${getErrorMessage(error)}`,
            );
            return null;
        });
        const previewRasterPlan = resolvePreviewRasterPlan(pageSizes);
        const sourceRasterStructure = await retention.rasterPages(document, signal);
        const detectionDpiForPage = (pageNumber: number) =>
            previewRasterPlan.detectionDpiByPageNumber.get(pageNumber)
            ?? Math.min(DETECTION_DPI, previewRasterPlan.dpi);
        const results = new Map<number, IScanCleanupDetectionResult>();
        const publishedResults = () => [...results.values()]
            .sort((left, right) => left.pageNumber - right.pageNumber);
        let analyzedPages = 0;
        // Detection and visible previews use the native classifier's 150-DPI
        // ceiling without upsampling a proven lower-resolution page. On POSIX,
        // feed raw PPM through FIFOs so native starts classifying the first page
        // while Poppler is still producing the rest.
        const streamRasters = process.platform !== 'win32'
            && dependencies.createRasterPipes !== undefined;
        const retained = new Map<number, IRetainedRawRaster>();
        if (!streamRasters) {
            const pagesByDpi = new Map<number, number[]>();
            for (const pageNumber of pageNumbers) {
                const dpi = detectionDpiForPage(pageNumber);
                const group = pagesByDpi.get(dpi) ?? [];
                group.push(pageNumber);
                pagesByDpi.set(dpi, group);
            }
            for (const [
                dpi,
                pages,
            ] of pagesByDpi) {
                for (const [
                    pageNumber,
                    raster,
                ] of await retention.retainedPaths(
                        document,
                        pages,
                        dpi,
                    )) {
                    retained.set(pageNumber, raster);
                }
            }
        }
        const rasterScope = pageNumbers.filter(pageNumber => !retained.has(pageNumber));
        const rasterizedPageNumbers = new Set<number>(retained.keys());
        const publishRasterizing = () => publish([], {
            stage: 'rasterizing',
            completedUnits: rasterizedPageNumbers.size,
            totalUnits: totalPages,
            percent: totalPages === 0 ? 100 : rasterizedPageNumbers.size / totalPages * 100,
            completedPageNumbers: [...rasterizedPageNumbers],
        });
        publishRasterizing();
        const renderedPaths = new Map<number, string>();
        if (streamRasters) {
            for (const pageNumber of rasterScope) {
                renderedPaths.set(pageNumber, join(scratch, `detect-${pageNumber}.ppm`));
            }
            await dependencies.createRasterPipes!(
                [...renderedPaths.values()],
                signal,
                (level, message) => logger[level](message),
            );
        }
        const rasterize = async (operationSignal: AbortSignal) => {
            await mapDetectionPages(rasterScope, async pageNumber => {
                operationSignal.throwIfAborted();
                if (streamRasters) {
                    await dependencies.renderPagePpm(
                        {pdftoppmBinary: dependencies.getPdftoppmBinary()},
                        (level, message) => logger[level](message),
                        pageNumber,
                        request.sourcePdfPath,
                        renderedPaths.get(pageNumber)!,
                        detectionDpiForPage(pageNumber),
                        undefined,
                        operationSignal,
                    );
                    return;
                }
                const pageDpi = detectionDpiForPage(pageNumber);
                const scratchPath = await retention.rasterScratchPath(document, pageNumber, pageDpi);
                const dimensions = await renderRasterToDisk(
                    request.sourcePdfPath,
                    pageNumber,
                    scratchPath,
                    operationSignal,
                    dependencies,
                    pageDpi,
                );
                const raster = await retention.retain({
                    document,
                    dpi: pageDpi,
                    height: dimensions.height,
                    pageNumber,
                    scratchPath,
                    sizeBytes: (await stat(scratchPath)).size,
                    width: dimensions.width,
                });
                renderedPaths.set(pageNumber, raster.path);
            }, pageNumber => {
                rasterizedPageNumbers.add(pageNumber);
                // Once classifications are arriving, publishing raster
                // progress would replace them with an older-stage empty
                // snapshot. Detection progress is the useful foreground state.
                if (results.size === 0) publishRasterizing();
            }, streamRasters
                // The native consumer opens FIFO inputs in manifest order.
                // Multiple producers can run ahead, block while opening later
                // pipes and exhaust every admitted process before the current
                // page is available. One producer still overlaps Poppler with
                // native analysis without creating that circular wait.
                ? 1
                : resolveScanCleanupRasterConcurrency());
        };
        if (!streamRasters) await rasterize(signal);
        const manifestPages = pageNumbers.map(pageNumber => {
            const sourceBackgroundDpi = sourceRasterStructure.backgroundDpiByPage?.get(pageNumber);
            return {
                inputPath: renderedPaths.get(pageNumber) ?? retained.get(pageNumber)!.path,
                pageNumber,
                dpi: detectionDpiForPage(pageNumber),
                sourceDpi: previewRasterPlan.pageDpiByNumber.get(pageNumber)
                    ?? detectionDpiForPage(pageNumber),
                sourceHasBilevelLayer: sourceRasterStructure.bilevelLayerPages
                    ?.has(pageNumber) ?? false,
                ...(sourceBackgroundDpi === undefined ? {} : {sourceBackgroundDpi}),
                pageMetadataPath: join(scratch, `page-${pageNumber}.json`),
            };
        });
        if (signal.aborted) throw signal.reason;
        // Every page stays in one manifest because final reconciliation
        // clusters the document's independent verdicts. The FIFO handoff does
        // not chunk that semantic unit: it merely lets native publish each
        // provisional verdict while later pages are still being rasterized,
        // then replace them with reconciled verdicts at the end.
        const manifestPath = join(scratch, 'classify-manifest.json');
        await writeFile(manifestPath, JSON.stringify(buildNativeScanCleanupManifest({
            operation: 'analyze',
            analysisPurpose: 'page-plan',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: request.options.preserveOriginalQuality ? 'lossless' : 'raster',
            options: request.options,
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined
                    ? {}
                    : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            pages: manifestPages,
        })));
        const binary = dependencies.resolveBinary();
        if (!binary) throw new Error('Scan cleanup native tool is unavailable');
        const recordResult = (nativeProgress: TNativeScanCleanupProgressV3) => {
            if (
                nativeProgress.pageNumber === undefined
                || nativeProgress.classification === undefined
                || nativeProgress.confidence === undefined
            ) {
                return false;
            }
            const sourcePage = pageSizes?.[nativeProgress.pageNumber - 1];
            const sourceDpi = previewRasterPlan.pageDpiByNumber.get(nativeProgress.pageNumber);
            const revision = (results.get(nativeProgress.pageNumber)?.revision ?? 0) + 1;
            results.set(nativeProgress.pageNumber, {
                pageNumber: nativeProgress.pageNumber,
                revision,
                classification: nativeProgress.classification,
                confidence: nativeProgress.confidence,
                cutterXPx: nativeProgress.cutterXPx ?? null,
                tier1Verdict: nativeProgress.tier1Verdict ?? nativeProgress.classification,
                reconciled: nativeProgress.reconciled ?? false,
                clusterAgreement: nativeProgress.clusterAgreement ?? 0,
                documentPrior: nativeProgress.documentPrior ?? null,
                ...(nativeProgress.textAxis === undefined ? {} : {textAxis: nativeProgress.textAxis}),
                ...(nativeProgress.recommendedOutputMode === undefined
                    ? {}
                    : {recommendedOutputMode: nativeProgress.recommendedOutputMode}),
                ...(nativeProgress.recommendedOutputModeConfidence === undefined
                    ? {}
                    : {recommendedOutputModeConfidence: nativeProgress.recommendedOutputModeConfidence}),
                ...(nativeProgress.recommendedOutputModeReason === undefined
                    ? {}
                    : {recommendedOutputModeReason: nativeProgress.recommendedOutputModeReason}),
                ...(nativeProgress.softAlphaForegroundRecommendation === undefined
                    ? {}
                    : {softAlphaForegroundRecommendation: nativeProgress.softAlphaForegroundRecommendation}),
                ...(nativeProgress.outputModeDiagnostics === undefined
                    ? {}
                    : {outputModeDiagnostics: nativeProgress.outputModeDiagnostics}),
                ...(sourcePage === undefined || sourceDpi === undefined
                    ? {}
                    : {sourcePageMetadata: {
                        ...sourcePage,
                        sourceDpi,
                    }}),
            });
            return true;
        };
        const runAnalysis = (operationSignal: AbortSignal) => dependencies.runSidecar(
            binary,
            manifestPath,
            operationSignal,
            (level, message) => logger[level](message),
            (progress, nativeProgress) => {
                if (nativeProgress.stage === 'page-analyzed') {
                    analyzedPages = Math.max(analyzedPages, progress.completedUnits);
                    recordResult(nativeProgress);
                    publish(publishedResults(), {
                        ...progress,
                        stage: 'detecting',
                        completedUnits: analyzedPages,
                        percent: progress.totalUnits === 0 ? 100 : analyzedPages / progress.totalUnits * 100,
                    });
                    return;
                }
                if (nativeProgress.stage !== 'page-complete' || !recordResult(nativeProgress)) {
                    return;
                }
                const completedUnits = Math.max(analyzedPages, progress.completedUnits);
                publish(publishedResults(), {
                    ...progress,
                    stage: 'detecting',
                    completedUnits,
                    percent: progress.totalUnits === 0 ? 100 : completedUnits / progress.totalUnits * 100,
                });
            },
            {priority: 'background'},
        );
        if (streamRasters) {
            const streamAbort = new AbortController();
            const streamSignal = AbortSignal.any([
                signal,
                streamAbort.signal,
            ]);
            const analysis = runAnalysis(streamSignal).catch((error: unknown) => {
                streamAbort.abort(error);
                throw error;
            });
            const rasterization = rasterize(streamSignal).catch((error: unknown) => {
                streamAbort.abort(error);
                throw error;
            });
            try {
                await Promise.all([
                    rasterization,
                    analysis,
                ]);
            } catch (error) {
                streamAbort.abort(error);
                await Promise.allSettled([
                    rasterization,
                    analysis,
                ]);
                throw error;
            }
        } else {
            await runAnalysis(signal);
        }
        for (const page of manifestPages) {
            const result = results.get(page.pageNumber);
            if (!result) {
                continue;
            }
            const metadata = JSON.parse(
                await readFile(page.pageMetadataPath, 'utf8'),
            ) as INativeScanCleanupPageMetadataV3;
            result.pagePlanEvidence = createDetectionPagePlanEvidence(
                result,
                metadata,
                request.options.autoDewarp !== true,
            );
        }
        if (results.size !== totalPages) {
            throw new Error(`evb-scan-cleanup returned ${results.size} classifications for ${totalPages} pages`);
        }
        return {results: publishedResults()};
    } finally {
        await retention.release(document);
        if (scratchDir !== null) {
            await preserveScanCleanupJsonEvidence(
                scratchDir,
                (level, message) => logger[level](message),
            ).catch(error => {
                logger.warn(
                    `Could not preserve scan-cleanup detection evidence: ${getErrorMessage(error)}`,
                );
            });
            await rm(scratchDir, {
                recursive: true,
                force: true,
            });
        }
    }
}

export interface IScanCleanupPreviewService {
    preview: (sender: IScanCleanupDetectionSubscriber, request: IScanCleanupPreviewRequest) => Promise<TScanCleanupPreviewWireResult>;
    cancel: (sender: IScanCleanupDetectionSubscriber, request: IScanCleanupPreviewCancelRequest) => boolean;
    detectAll: (sender: IScanCleanupDetectionSubscriber, request: IScanCleanupDetectionRequest) => Promise<TScanCleanupDetectionStartResult>;
    cancelDetection: (sender: IScanCleanupDetectionSubscriber, jobId: string, owner: IScanCleanupOwnerContext) => boolean;
    getDetectionJobState: (sender: IScanCleanupDetectionSubscriber, jobId: string, owner: IScanCleanupOwnerContext) => TScanCleanupDetectionJobState | null;
    subscribeDetectionJob: (sender: IScanCleanupDetectionSubscriber, jobId: string, owner: IScanCleanupOwnerContext) => TScanCleanupDetectionJobState | null;
}

export function createScanCleanupPreviewService(
    dependencies: IScanCleanupPreviewDependencies = defaultDependencies,
): IScanCleanupPreviewService {
    const active = new Map<string, IPreviewEntry>();
    const rawRasterRetention = createRawRasterRetention(dependencies);
    const baseAnalysisCache = new Map<string, IBasePreviewAnalysis>();
    // Streamed detection events carry new *and revised* page classifications.
    // Native first publishes an independent verdict, then may replace it after
    // document reconciliation. A count cursor loses that replacement because
    // it sits below the append position; page signatures retain the bandwidth
    // bound without making revisions invisible to the renderer.
    const deliveredDetectionResults = new Map<string, Map<number, number | string>>();
    const detectionResultVersion = (result: IScanCleanupDetectionResult) => result.revision ?? JSON.stringify([
        result.classification,
        result.confidence,
        result.cutterXPx,
        result.tier1Verdict,
        result.reconciled,
        result.clusterAgreement,
        result.documentPrior,
        result.textAxis,
        result.recommendedOutputMode,
        result.recommendedOutputModeConfidence,
        result.recommendedOutputModeReason,
        result.softAlphaForegroundRecommendation,
        result.pagePlanEvidence,
    ]);
    const detectionDeliveryKey = (senderId: number, jobId: string) => `${senderId}\u0000${jobId}`;
    const detectionJobs = createMainJobRegistry<
        TScanCleanupDetectionJobState,
        IDetectionResult,
        TDetectionError,
        IScanCleanupDetectionSubscriber
    >({
        retention: {
            eventReplayTtlMs: 60_000,
            terminalRecordTtlMs: 60_000,
        },
        progress: {
            channel: SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onDetectionJobState,
            getEventKey: state => state.jobId,
            send: (subscriber, channel, state) => {
                const deliveryKey = detectionDeliveryKey(subscriber.id, state.jobId);
                if (state.status === 'queued' || state.status === 'running' || state.status === 'canceling') {
                    const delivered = deliveredDetectionResults.get(deliveryKey)
                        ?? new Map<number, number | string>();
                    const changed = state.results.filter(result => {
                        const signature = detectionResultVersion(result);
                        if (delivered.get(result.pageNumber) === signature) {
                            return false;
                        }
                        delivered.set(result.pageNumber, signature);
                        return true;
                    });
                    deliveredDetectionResults.set(deliveryKey, delivered);
                    subscriber.send(channel, {
                        ...state,
                        results: changed,
                    });
                    return;
                }
                deliveredDetectionResults.delete(deliveryKey);
                subscriber.send(channel, state);
            },
        },
        toError: (cause, kind) => ({
            code: classifyScanCleanupError(cause, kind === 'canceled'),
            message: getErrorMessage(cause),
        }),
        terminalProgress: {
            completed: (latest, result) => ({
                jobId: latest.jobId,
                status: 'completed',
                progress: {
                    stage: 'detecting',
                    completedUnits: result.results.length,
                    totalUnits: result.results.length,
                    percent: 100,
                    completedPageNumbers: result.results.map(item => item.pageNumber),
                },
                results: result.results,
                updatedAtMs: Date.now(),
            }),
            canceled: latest => ({
                ...latest,
                status: 'canceled',
                updatedAtMs: Date.now(),
            }),
            failed: (latest, error) => ({
                ...latest,
                status: 'failed',
                error: error.message,
                errorCode: error.code,
                updatedAtMs: Date.now(),
            }),
        },
    });
    const detectionActor = (sender: IScanCleanupDetectionSubscriber, owner: IScanCleanupOwnerContext) => ({
        sender,
        ownerId: owner.ownerId,
        documentRevision: owner.documentRevision,
    });
    const publicDetectionState = (snapshot: TDetectionSnapshot | null) => snapshot?.progress ?? null;
    const subscribeDetection = (
        sender: IScanCleanupDetectionSubscriber,
        jobId: string,
        owner: IScanCleanupOwnerContext,
    ) => {
        // The registry pumps every state change to the job owner, so subscribing
        // only has to authorize the sender and restart its result cursor: the
        // caller is handed the whole state and must be able to rebuild from it.
        if (!detectionJobs.get(jobId, detectionActor(sender, owner))) {
            return false;
        }
        deliveredDetectionResults.delete(detectionDeliveryKey(sender.id, jobId));
        return true;
    };
    const previewOwnerPrefix = (
        sender: IScanCleanupDetectionSubscriber,
        owner: IScanCleanupOwnerContext,
    ) => `${sender.id}\u0000${owner.ownerId}\u0000`;
    const previewDocumentPrefix = (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupOwnerContext & {sourcePdfPath: string},
    ) => `${previewOwnerPrefix(sender, request)}${request.documentRevision}\u0000${request.sourcePdfPath}\u0000`;
    // The page the user navigated onto, named by the request that streams its
    // raw raster back, so the adjacent prefetches that do not are admitted
    // behind it. One entry per document an owner is working on, dropped when
    // that owner moves on or cancels the document.
    const visiblePages = new Map<string, number>();
    const abortStalePreviewRequests = (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupOwnerContext & {sourcePdfPath: string},
    ) => {
        const ownerPrefix = previewOwnerPrefix(sender, request);
        const documentPrefix = previewDocumentPrefix(sender, request);
        for (const [
            key,
            entry,
        ] of active) {
            if (key.startsWith(ownerPrefix) && !key.startsWith(documentPrefix)) {
                entry.controller.abort(new DOMException('Stale scan cleanup preview document', 'AbortError'));
            }
        }
        // The owner moved to another document or revision, so the page it was
        // looking at in the old one is not a visible page any more. Without
        // this the map keeps one entry per document a session ever opened.
        for (const key of visiblePages.keys()) {
            if (key.startsWith(ownerPrefix) && key !== documentPrefix) visiblePages.delete(key);
        }
        return documentPrefix;
    };
    const previewLanePrefix = (
        documentPrefix: string,
        request: IScanCleanupPreviewRequest,
    ) => `${documentPrefix}${request.detail === undefined ? 'base' : 'detail'}\u0000`;
    const withPreviewLease = async <T>(
        documentPrefix: string,
        admission: IPreviewAdmission,
        signal: AbortSignal,
        run: () => Promise<T>,
    ) => {
        signal.throwIfAborted();
        const acquire = dependencies.acquirePreviewLease ?? defaultDependencies.acquirePreviewLease!;
        let lease: {release: () => boolean};
        for (;;) {
            const attempt = new AbortController();
            const abortAttempt = () => attempt.abort(signal.reason);
            signal.addEventListener('abort', abortAttempt, {once: true});
            admission.reissue = () => attempt.abort(PREVIEW_ADMISSION_REISSUED);
            try {
                lease = await acquire(documentPrefix, admission.visibility, attempt.signal);
                admission.granted = true;
                break;
            } catch (error) {
                signal.throwIfAborted();
                // Anything but a readmission is the request's own failure.
                if (attempt.signal.reason !== PREVIEW_ADMISSION_REISSUED) throw error;
            } finally {
                signal.removeEventListener('abort', abortAttempt);
                admission.reissue = null;
            }
        }
        try {
            return await run();
        } finally {
            lease.release();
        }
    };
    // Request identity is the page and the content that would be rendered, not
    // just the document and the lane. Two requests that would produce the same
    // result now share one run instead of the second aborting the first.
    const previewRequestKey = (documentPrefix: string, request: IScanCleanupPreviewRequest) => {
        const {
            detail,
            ...base
        } = request;
        return `${previewLanePrefix(documentPrefix, request)}${previewIdentityKey(base)}\u0000${
            detail === undefined ? '' : JSON.stringify(detail)
        }`;
    };
    return {
        preview(sender, request) {
            const documentPrefix = abortStalePreviewRequests(sender, request);
            // The renderer names the page the user is looking at on the request
            // that will display it; everything else is an adjacent prefetch.
            if (request.visible === true) visiblePages.set(documentPrefix, request.pageNumber);
            const activeKey = previewRequestKey(documentPrefix, request);
            // Navigating onto a page whose prefetch is still running adopts that
            // run: no second raster, no second sidecar, and the caller inherits
            // the progress already made rather than restarting it. A run that
            // has already been aborted has nothing to inherit and is left to
            // retire; this request starts its own.
            const adopted = active.get(activeKey);
            if (adopted && !adopted.controller.signal.aborted) {
                // The adopted run was admitted as background work. It is now the
                // page the user is waiting on, so it is readmitted as one rather
                // than holding its place in a queue behind detection.
                if (request.visible === true && adopted.admission.visibility === 'prefetch') {
                    adopted.admission.visibility = 'visible';
                    adopted.admission.reissue?.();
                }
                return adopted.tail;
            }
            // A base request only supersedes work for its own page: a stale
            // options generation for the page being rendered. Adjacent prefetches
            // for other pages are the renderer's to retire, through `cancel`.
            // A detail tile is the one visible viewport, so it supersedes the
            // whole detail lane and still never touches the base lane.
            const lanePrefix = previewLanePrefix(documentPrefix, request);
            const superseded: IPreviewEntry[] = [];
            for (const [
                key,
                entry,
            ] of active) {
                if (
                    key.startsWith(lanePrefix)
                    && (request.detail !== undefined || entry.pageNumber === request.pageNumber)
                ) {
                    superseded.push(entry);
                    entry.controller.abort(new DOMException('Superseded scan cleanup preview', 'AbortError'));
                }
            }
            const controller = new AbortController();
            // The generation counts replacements of *this* key. Taking it from
            // whichever superseded entry the lane happened to iterate first
            // could hand a live entry the generation an older one is still
            // carrying, and that entry's late tail would then delete the
            // replacement out of the index.
            const generation = (active.get(activeKey)?.generation ?? 0) + 1;
            const priorTail = Promise.all(superseded.map(entry => entry.tail.catch(() => undefined)));
            // A detail tile is the viewport the user is looking at, and a page
            // the raw lane has not named is the first page of a session that has
            // no visible page yet. Everything else is an adjacent prefetch.
            const visiblePage = visiblePages.get(documentPrefix);
            const admission: IPreviewAdmission = {
                granted: false,
                reissue: null,
                visibility: request.detail !== undefined
                    || visiblePage === undefined
                    || visiblePage === request.pageNumber
                    ? 'visible'
                    : 'prefetch',
            };
            const tail: Promise<TScanCleanupPreviewWireResult> = priorTail.then(async () => {
                const materialized = await materializeScanCleanupPreviewRequest(
                    request,
                    sender.id,
                    controller.signal,
                    dependencies,
                );
                return withPreviewLease(documentPrefix, admission, controller.signal, async () => {
                    const result = await runPreview(
                        materialized,
                        controller.signal,
                        rawRasterRetention,
                        baseAnalysisCache,
                        dependencies,
                        raw => sender.send(SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onPreviewRaw, raw),
                    );
                    return result.canceled === true
                        ? result
                        : {
                            ...result,
                            requestId: materialized.requestId,
                        };
                });
            }).catch(error => {
                // A tab/pane can retire its working-copy registration after the
                // materialization abort check but before the queued request
                // reaches the registry. In that race the registry correctly
                // reports an ownership error, but the request has already been
                // canceled and must settle like every other superseded preview
                // instead of surfacing as an IPC handler failure.
                if (controller.signal.aborted || isPreviewCancellation(error)) {
                    return {canceled: true} as const;
                }
                throw error;
            });
            active.set(activeKey, {
                admission,
                controller,
                generation,
                pageNumber: request.pageNumber,
                tail,
            });
            if (admission.visibility === 'prefetch') {
                const drop = setTimeout(() => {
                    if (admission.granted || admission.visibility !== 'prefetch') {
                        return;
                    }
                    controller.abort(new DOMException('Dropped scan cleanup preview prefetch', 'AbortError'));
                }, dependencies.prefetchLeaseTimeoutMs ?? PREVIEW_PREFETCH_LEASE_TIMEOUT_MS);
                void tail.catch(() => undefined).finally(() => clearTimeout(drop));
            }
            void tail.finally(() => {
                if (active.get(activeKey)?.generation === generation) active.delete(activeKey);
            }).catch(() => undefined);
            return tail;
        },
        cancel(sender, request) {
            const documentPrefix = previewDocumentPrefix(sender, request);
            // A navigation names the pages it is moving into; only work for
            // pages outside that window is discarded. Without a window the
            // caller means the whole document: a settings change, a new
            // revision, or a session shutting down.
            const retained = new Set(request.retainPages ?? []);
            let canceled = false;
            for (const [
                key,
                entry,
            ] of active) {
                if (key.startsWith(documentPrefix) && !retained.has(entry.pageNumber)) {
                    entry.controller.abort(new DOMException('Canceled scan cleanup preview', 'AbortError'));
                    canceled = true;
                }
            }
            // A windowed cancellation is always issued for a navigation that
            // still wants the visible page, so only a whole-document
            // cancellation forgets which page that is.
            if (request.retainPages === undefined) visiblePages.delete(documentPrefix);
            if (request.invalidateRawCache !== false) {
                rawRasterRetention.invalidate(request.sourcePdfPath, request.documentRevision);
                for (const [
                    key,
                    analysis,
                ] of baseAnalysisCache) {
                    if (
                        analysis.sourcePdfPath === request.sourcePdfPath
                        && analysis.documentRevision === request.documentRevision
                    ) {
                        baseAnalysisCache.delete(key);
                    }
                }
            }
            return canceled;
        },
        detectAll(sender, request) {
            const jobId = `scan-cleanup-detect-${randomUUID()}`;
            if (!isAbsolute(request.sourcePdfPath)) {
                return Promise.resolve({
                    started: false,
                    jobId,
                    error: 'Source must be an absolute path',
                    errorCode: 'invalid-request',
                });
            }
            detectionJobs.start({
                jobId,
                owner: detectionActor(sender, request),
                operation: {
                    kind: 'abortable-work',
                    workingCopyPath: request.sourcePdfPath,
                },
                initialProgress: {
                    jobId,
                    status: 'queued',
                    progress: {
                        stage: 'queued',
                        completedUnits: 0,
                        totalUnits: 0,
                        percent: 0,
                        completedPageNumbers: [],
                    },
                    results: [],
                    updatedAtMs: Date.now(),
                },
                ownerLifecycle: {
                    destroyed: 'detach',
                    renderProcessGone: 'detach',
                    mainFrameNavigation: 'detach',
                },
                run: async job => {
                    let lease: {release: () => boolean} | null = null;
                    try {
                        const acquire = dependencies.acquireDetectionLease ?? defaultDependencies.acquireDetectionLease!;
                        lease = await acquire(jobId, job.signal);
                        const materializedRequest = await materializeScanCleanupPreviewRequest(
                            request,
                            sender.id,
                            job.signal,
                            dependencies,
                        );
                        const detection = await runDetection(
                            materializedRequest,
                            job.signal,
                            rawRasterRetention,
                            dependencies,
                            (nextResults, progress) => job.publish({
                                jobId,
                                status: 'running',
                                progress,
                                results: nextResults,
                                updatedAtMs: Date.now(),
                            }),
                        );
                        return {results: detection.results};
                    } finally {
                        lease?.release();
                    }
                },
            });
            subscribeDetection(sender, jobId, request);
            return Promise.resolve({
                started: true,
                jobId,
            });
        },
        cancelDetection(sender, jobId, owner) {
            const actor = detectionActor(sender, owner);
            const state = publicDetectionState(detectionJobs.get(jobId, actor));
            if (!state || [
                'completed',
                'failed',
                'canceled',
            ].includes(state.status)) {
                return false;
            }
            return detectionJobs.cancel(jobId, actor, 'Scan cleanup detection canceled');
        },
        getDetectionJobState(sender, jobId, owner) {
            return publicDetectionState(detectionJobs.get(jobId, detectionActor(sender, owner)));
        },
        subscribeDetectionJob(sender, jobId, owner) {
            return subscribeDetection(sender, jobId, owner)
                ? publicDetectionState(detectionJobs.get(jobId, detectionActor(sender, owner)))
                : null;
        },
    };
}
