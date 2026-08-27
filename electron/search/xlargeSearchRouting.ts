import {stat} from 'node:fs/promises';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {
    abortErrorFromSignal,
    createAbortError,
} from '@electron/utils/abort';
import type {
    IXlargeSearchIndexBuildOptions,
    IXlargeSearchIndexBuildProgress,
    IXlargeSearchIndexBuildResult,
} from '@electron/search/xlargeIndexBuilder';

/** Keep the eager search-index route within the existing whole-value budget. */
export const SEARCH_JS_WHOLE_VALUE_MAX_BYTES = 16 * 1024 * 1024;

/** Above this count, retaining one page object per document is not acceptable. */
export const SEARCH_XLARGE_PAGE_COUNT_THRESHOLD = 200;

export interface IXlargeSearchPathClassification {
    isXlarge: boolean;
    pageCount: number | undefined;
    pathSizeBytes: number | undefined;
    reasons: ReadonlyArray<'path-size' | 'page-count'>;
}

export interface IXlargeSearchPathClassificationInput {
    pageCount?: number;
    pathSizeBytes?: number;
}

export interface IXlargeSearchBuildRequest extends Omit<IXlargeSearchIndexBuildOptions, 'onProgress' | 'signal'> {
    onProgress?: (progress: IXlargeSearchIndexBuildProgress) => void | Promise<void>;
    signal?: AbortSignal;
}

interface IXlargeSearchBuildFlight {
    controller: AbortController;
    promise: Promise<IXlargeSearchIndexBuildResult>;
    waiterCount: number;
    progressListeners: Set<(progress: IXlargeSearchIndexBuildProgress) => void | Promise<void>>;
}

const inFlightXlargeSearchBuilds = new Map<string, IXlargeSearchBuildFlight>();

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value > 0;
}

/**
 * Classify a path-backed search request without reading the document. The page
 * count is a routing hint only. It never rejects a document when it is large.
 */
export function classifyXlargeSearchPath(
    input: IXlargeSearchPathClassificationInput,
): IXlargeSearchPathClassification {
    const pageCount = isPositiveSafeInteger(input.pageCount)
        ? input.pageCount
        : undefined;
    const pathSizeBytes = isPositiveFiniteNumber(input.pathSizeBytes)
        ? input.pathSizeBytes
        : undefined;
    const reasons: Array<'path-size' | 'page-count'> = [];
    if (pathSizeBytes !== undefined && pathSizeBytes > SEARCH_JS_WHOLE_VALUE_MAX_BYTES) {
        reasons.push('path-size');
    }
    if (pageCount !== undefined && pageCount > SEARCH_XLARGE_PAGE_COUNT_THRESHOLD) {
        reasons.push('page-count');
    }
    return {
        isXlarge: reasons.length > 0,
        pageCount,
        pathSizeBytes,
        reasons,
    };
}

/** Read only the scalar file size needed by the xlarge classifier. */
export async function classifyXlargeSearchPathFromFile(
    pdfPath: string,
    pageCount?: number,
): Promise<IXlargeSearchPathClassification> {
    let pathSizeBytes: number | undefined;
    try {
        const fileStat = await stat(pdfPath);
        if (isPositiveFiniteNumber(fileStat.size)) {
            pathSizeBytes = fileStat.size;
        }
    } catch {
        // The caller's normal path validation reports a missing source. An
        // unknown size must not turn a known high-page-count request into a
        // legacy whole-document operation.
    }
    return classifyXlargeSearchPath({
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(pathSizeBytes === undefined ? {} : {pathSizeBytes}),
    });
}

function getBuildKey(pdfPath: string, documentRevision: TDocumentRevisionToken) {
    return `${pdfPath}\0${documentRevision}`;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

async function publishProgress(
    flight: IXlargeSearchBuildFlight,
    progress: IXlargeSearchIndexBuildProgress,
) {
    // A progress observer belongs to one request. Its cancellation or a
    // renderer teardown must not abort the shared writer or another observer.
    await Promise.allSettled(Array.from(flight.progressListeners, listener => (
        Promise.resolve().then(() => listener(progress))
    )));
}

function createBuildFlight(options: IXlargeSearchBuildRequest, key: string) {
    const controller = new AbortController();
    const flight: IXlargeSearchBuildFlight = {
        controller,
        promise: Promise.resolve().then(async () => {
            const {buildXlargeSearchIndex} = await import('@electron/search/xlargeIndexBuilder');
            const buildOptions: IXlargeSearchIndexBuildOptions = {
                ...options,
                signal: controller.signal,
                onProgress: progress => publishProgress(flight, progress),
            };
            return buildXlargeSearchIndex(buildOptions);
        }),
        waiterCount: 0,
        progressListeners: new Set(),
    };
    const cleanup = () => {
        if (inFlightXlargeSearchBuilds.get(key) === flight) {
            inFlightXlargeSearchBuilds.delete(key);
        }
    };
    void flight.promise.then(cleanup, cleanup);
    inFlightXlargeSearchBuilds.set(key, flight);
    return flight;
}

function waitForBuild(
    flight: IXlargeSearchBuildFlight,
    signal: AbortSignal | undefined,
    onProgress: IXlargeSearchBuildRequest['onProgress'],
) {
    throwIfAborted(signal);
    flight.waiterCount += 1;
    if (onProgress) {
        flight.progressListeners.add(onProgress);
    }

    let released = false;
    const release = (abortWhenOrphaned: boolean) => {
        if (released) {
            return;
        }
        released = true;
        flight.waiterCount = Math.max(0, flight.waiterCount - 1);
        if (onProgress) {
            flight.progressListeners.delete(onProgress);
        }
        if (
            abortWhenOrphaned
            && flight.waiterCount === 0
            && !flight.controller.signal.aborted
        ) {
            for (const [
                flightKey,
                candidate,
            ] of inFlightXlargeSearchBuilds.entries()) {
                if (candidate === flight) {
                    inFlightXlargeSearchBuilds.delete(flightKey);
                    break;
                }
            }
            flight.controller.abort(signal ? abortErrorFromSignal(signal) : createAbortError());
        }
    };

    return new Promise<IXlargeSearchIndexBuildResult>((resolve, reject) => {
        const handleAbort = () => {
            release(true);
            reject(signal ? abortErrorFromSignal(signal) : createAbortError());
        };
        if (signal) {
            signal.addEventListener('abort', handleAbort, {once: true});
        }
        flight.promise.then(
            result => {
                release(false);
                signal?.removeEventListener('abort', handleAbort);
                resolve(result);
            },
            error => {
                release(false);
                signal?.removeEventListener('abort', handleAbort);
                reject(error);
            },
        );
        if (signal?.aborted) {
            handleAbort();
        }
    });
}

/**
 * Build a streaming sidecar once per path and revision. Each caller owns its
 * cancellation signal, while the underlying writer remains alive for all
 * remaining callers.
 */
export function ensureXlargeSearchIndex(options: IXlargeSearchBuildRequest) {
    throwIfAborted(options.signal);
    const key = getBuildKey(options.pdfPath, options.documentRevision);
    const flight = inFlightXlargeSearchBuilds.get(key) ?? createBuildFlight(options, key);
    return waitForBuild(flight, options.signal, options.onProgress);
}

export function resetXlargeSearchIndexBuilds(reason = 'Search index cache reset') {
    const error = new Error(reason);
    for (const flight of inFlightXlargeSearchBuilds.values()) {
        flight.controller.abort(error);
    }
    inFlightXlargeSearchBuilds.clear();
}
