import { statfs } from 'fs/promises';
import type { TWorkerLog } from '@electron/ocr/worker/types';

// PPM removes the costly PNG encode/decode step on both sides of the native
// handoff: pdftoppm writes a JPEG 2000 scan page in about a second where the
// same page spends five more seconds in deflate. The cost is scratch space.
// Retained handoffs budget the whole manifest; FIFO handoffs budget only the
// rasterizer's concurrent window because the native consumer drains each page
// while Poppler produces it.
const RAW_RASTER_BUDGET_FLOOR_BYTES = 512 * 1024 * 1024;
const RAW_RASTER_FREE_SPACE_SHARE = 0.25;
const PPM_HEADER_ESTIMATE_BYTES = 64;
const COMBINE_OUTPUT_BYTES_PER_PAGE = 8 * 1024 * 1024;
const COMBINE_OUTPUT_BYTES_FLOOR = 512 * 1024 * 1024;

export interface IScanCleanupRasterHandoffPlan {
    renderDpi: number;
    raster: {
        dpi: number;
        width: number;
        height: number
    } | undefined;
}

export async function readAvailableScratchBytes(directory: string) {
    try {
        const filesystem = await statfs(directory);
        const available = Number(filesystem.bavail) * Number(filesystem.bsize);
        return Number.isFinite(available) && available > 0 ? available : null;
    } catch {
        return null;
    }
}

function estimateRawRasterBytes(
    plans: readonly IScanCleanupRasterHandoffPlan[],
    residentRasterCount: number,
) {
    const pageEstimates: number[] = [];
    for (const plan of plans) {
        const raster = plan.raster;
        if (
            raster === undefined
            || !Number.isFinite(plan.renderDpi)
            || plan.renderDpi <= 0
            || !Number.isFinite(raster.dpi)
            || raster.dpi <= 0
            || !Number.isFinite(raster.width)
            || raster.width <= 0
            || !Number.isFinite(raster.height)
            || raster.height <= 0
        ) {
            return null;
        }
        const width = Math.max(1, Math.ceil(raster.width * plan.renderDpi / raster.dpi));
        const height = Math.max(1, Math.ceil(raster.height * plan.renderDpi / raster.dpi));
        const pageBytes = width * height * 3 + PPM_HEADER_ESTIMATE_BYTES;
        if (!Number.isSafeInteger(pageBytes)) {
            return null;
        }
        pageEstimates.push(pageBytes);
    }
    pageEstimates.sort((left, right) => right - left);
    const estimatedBytes = pageEstimates
        .slice(0, Math.max(1, residentRasterCount))
        .reduce((sum, pageBytes) => sum + pageBytes, 0);
    return Number.isSafeInteger(estimatedBytes) ? estimatedBytes : null;
}

export async function resolveRasterHandoff(
    plans: readonly IScanCleanupRasterHandoffPlan[],
    scratch: string,
    getAvailableScratchBytes: typeof readAvailableScratchBytes,
    residentRasterCount = plans.length,
) {
    const estimatedBytes = estimateRawRasterBytes(plans, residentRasterCount);
    if (estimatedBytes === null) {
        return {
            format: 'png' as const,
            estimatedBytes: null,
            budgetBytes: null,
        };
    }
    const availableBytes = await getAvailableScratchBytes(scratch);
    const budgetBytes = Math.max(
        RAW_RASTER_BUDGET_FLOOR_BYTES,
        availableBytes === null ? 0 : Math.floor(availableBytes * RAW_RASTER_FREE_SPACE_SHARE),
    );
    return {
        format: estimatedBytes > budgetBytes ? 'png' as const : 'ppm' as const,
        estimatedBytes,
        budgetBytes,
    };
}

export function resolveCombineOutputByteCap(outputPageCount: number) {
    return Math.max(COMBINE_OUTPUT_BYTES_FLOOR, outputPageCount * COMBINE_OUTPUT_BYTES_PER_PAGE);
}

export async function runRasterProducerConsumer({
    signal,
    stream,
    createStreams,
    produce,
    consume,
    onProducerComplete,
}: {
    signal: AbortSignal;
    stream: boolean;
    createStreams?: () => Promise<void>;
    produce: (signal: AbortSignal) => Promise<void>;
    consume: (signal: AbortSignal) => Promise<void>;
    onProducerComplete: () => void;
}) {
    if (!stream) {
        await produce(signal);
        onProducerComplete();
        await consume(signal);
        return;
    }

    if (createStreams === undefined) {
        throw new Error('Raster streaming requires a stream factory');
    }
    await createStreams();
    const abort = new AbortController();
    const operationSignal = AbortSignal.any([
        signal,
        abort.signal,
    ]);
    const run = (operation: (signal: AbortSignal) => Promise<void>) => operation(operationSignal)
        .catch((error: unknown) => {
            abort.abort(error);
            throw error;
        });
    // The consumer opens every FIFO for reading before the producer writes.
    // Starting it first prevents a producer open from blocking the event loop.
    const consumer = run(consume);
    const producer = run(produce);
    const combined = Promise.all([
        producer,
        consumer,
    ]);
    void combined.catch(() => undefined);
    try {
        await producer;
        onProducerComplete();
        await combined;
    } catch (error) {
        abort.abort(error);
        await Promise.allSettled([
            producer,
            consumer,
        ]);
        throw error;
    }
}

// Rasterizing a page is the pipeline's dominant cost and each one holds a full
// page bitmap, so the pages move through a fixed number of workers the runtime
// policy sizes rather than all at once.
export async function mapScanCleanupRasterPages<T, R>(
    values: readonly T[],
    concurrency: number,
    task: (value: T, index: number) => Promise<R>,
) {
    const results = new Array<R>(values.length);
    let nextIndex = 0;
    const workers = Array.from({length: Math.min(Math.max(1, concurrency), values.length)}, async () => {
        while (nextIndex < values.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await task(values[index]!, index);
        }
    });
    await Promise.all(workers);
    return results;
}

export function logRasterHandoff(
    log: TWorkerLog,
    scope: string,
    handoff: Awaited<ReturnType<typeof resolveRasterHandoff>>,
) {
    const mib = (bytes: number) => `${Math.ceil(bytes / (1024 * 1024))} MiB`;
    const footprint = handoff.estimatedBytes === null
        ? 'unknown footprint'
        : `${mib(handoff.estimatedBytes)} estimated footprint`;
    const budget = handoff.budgetBytes === null ? '' : ` against a ${mib(handoff.budgetBytes)} scratch budget`;
    log('debug', `Scan cleanup ${scope} raster handoff uses ${handoff.format.toUpperCase()} (${footprint}${budget})`);
}
