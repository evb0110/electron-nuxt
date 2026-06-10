import {
    availableParallelism,
    totalmem,
} from 'os';
import { partition } from 'es-toolkit/array';
import { clamp } from 'es-toolkit/math';
import { createLogger } from '@electron/utils/createLogger';

const log = createLogger('ocr-resource-governor');

const DEFAULT_PAGE_WIDTH_IN = 8.5;
const DEFAULT_PAGE_HEIGHT_IN = 11;
const BYTES_PER_RGBA_PIXEL = 4;
const MIB = 1024 * 1024;

const MAX_RENDERED_PIXELS = 45_000_000;
const LOW_MEMORY_BYTES = 8 * 1024 * MIB;
const NORMAL_PAGE_SLOTS = 3;
const LOW_MEMORY_PAGE_SLOTS = 2;
const HIGH_DPI_THRESHOLD = 450;
const HIGH_DPI_PAGE_SLOTS = 1;

export interface IOcrResourceRequest {
    jobId: string;
    pageNumber: number;
    requestedDpi: number;
    pageWidthIn?: number;
    pageHeightIn?: number;
}

interface IOcrResourceLease {
    token: string;
    jobId: string;
    slotLimit: number;
}

interface IQueuedResourceRequest {
    request: IOcrResourceRequest;
    effectiveDpi: number;
    slotLimit: number;
    resolve: (lease: IOcrResourceLease & { effectiveDpi: number }) => void;
    reject: (error: Error) => void;
}

function removeLease(
    activeLeases: ReadonlyMap<string, IOcrResourceLease>,
    predicate: (token: string, lease: IOcrResourceLease) => boolean,
) {
    return new Map(Array.from(activeLeases.entries()).filter(([
        token,
        lease,
    ]) => !predicate(token, lease)));
}

function parsePositiveInt(value: string | undefined) {
    if (!value) {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
}

function getPageDimensions(request: Pick<IOcrResourceRequest, 'pageWidthIn' | 'pageHeightIn'>) {
    const widthIn = typeof request.pageWidthIn === 'number' && Number.isFinite(request.pageWidthIn) && request.pageWidthIn > 0
        ? request.pageWidthIn
        : DEFAULT_PAGE_WIDTH_IN;
    const heightIn = typeof request.pageHeightIn === 'number' && Number.isFinite(request.pageHeightIn) && request.pageHeightIn > 0
        ? request.pageHeightIn
        : DEFAULT_PAGE_HEIGHT_IN;
    return {
        widthIn,
        heightIn,
    };
}

function estimateRenderedPixels(dpi: number, request: Pick<IOcrResourceRequest, 'pageWidthIn' | 'pageHeightIn'> = {}) {
    const {
        widthIn,
        heightIn,
    } = getPageDimensions(request);
    return Math.ceil(widthIn * dpi) * Math.ceil(heightIn * dpi);
}

function estimateRenderedBytes(dpi: number, request: Pick<IOcrResourceRequest, 'pageWidthIn' | 'pageHeightIn'> = {}) {
    return estimateRenderedPixels(dpi, request) * BYTES_PER_RGBA_PIXEL;
}

function capDpiForPixelBudget(request: IOcrResourceRequest) {
    const requestedPixels = estimateRenderedPixels(request.requestedDpi, request);
    if (requestedPixels <= MAX_RENDERED_PIXELS) {
        return request.requestedDpi;
    }

    const scale = Math.sqrt(MAX_RENDERED_PIXELS / requestedPixels);
    return Math.max(150, Math.floor(request.requestedDpi * scale));
}

function getDefaultSlotCount(effectiveDpi: number, request: IOcrResourceRequest) {
    const configured = parsePositiveInt(process.env.OCR_GLOBAL_PAGE_SLOTS);
    if (configured) {
        return clamp(configured, 1, 8);
    }

    const memoryBytes = totalmem();
    if (memoryBytes > 0 && memoryBytes < LOW_MEMORY_BYTES) {
        return LOW_MEMORY_PAGE_SLOTS;
    }

    if (effectiveDpi >= HIGH_DPI_THRESHOLD || estimateRenderedBytes(effectiveDpi, request) > (MAX_RENDERED_PIXELS * BYTES_PER_RGBA_PIXEL) / 2) {
        return HIGH_DPI_PAGE_SLOTS;
    }

    const cpuCount = typeof availableParallelism === 'function'
        ? availableParallelism()
        : 2;
    return clamp(Math.min(NORMAL_PAGE_SLOTS, Math.floor(cpuCount / 2)), 1, NORMAL_PAGE_SLOTS);
}

class OcrResourceGovernor {
    private activeLeases = new Map<string, IOcrResourceLease>();
    private queue: IQueuedResourceRequest[] = [];
    private tokenCounter = 0;

    async acquire(request: IOcrResourceRequest) {
        const effectiveDpi = capDpiForPixelBudget(request);
        const slotLimit = getDefaultSlotCount(effectiveDpi, request);

        if (effectiveDpi < request.requestedDpi) {
            log.debug(
                `[${request.jobId}] Reducing OCR render DPI for page ${request.pageNumber} from ${request.requestedDpi} to ${effectiveDpi}; estimated pixels would exceed ${MAX_RENDERED_PIXELS}`,
            );
        }

        if (this.queue.length === 0 && this.canGrant(slotLimit)) {
            return {
                ...this.createLease(request.jobId, slotLimit),
                effectiveDpi,
            };
        }

        return new Promise<IOcrResourceLease & { effectiveDpi: number }>((resolve, reject) => {
            this.queue.push({
                request: {
                    ...request,
                    requestedDpi: effectiveDpi,
                },
                effectiveDpi,
                slotLimit,
                resolve,
                reject,
            });
            log.debug(
                `[${request.jobId}] Queued OCR resource request for page ${request.pageNumber}; active=${this.activeLeases.size}/${this.getActiveSlotLimit()}, requestLimit=${slotLimit}, queued=${this.queue.length}`,
            );
        });
    }

    release(token: string) {
        if (!this.activeLeases.has(token)) {
            return;
        }
        this.activeLeases = removeLease(this.activeLeases, candidate => candidate === token);
        this.dispatch();
    }

    releaseJob(jobId: string) {
        this.activeLeases = removeLease(this.activeLeases, (_token, lease) => lease.jobId === jobId);

        this.settleQueuedRequests(
            item => item.request.jobId === jobId,
            `OCR resource request cancelled for job ${jobId}`,
        );
        this.dispatch();
    }

    reset() {
        this.activeLeases.clear();
        this.settleQueuedRequests(
            () => true,
            'OCR resource governor reset',
        );
    }

    private createLease(jobId: string, slotLimit: number): IOcrResourceLease {
        const token = `${Date.now()}-${++this.tokenCounter}`;
        const lease = {
            token,
            jobId,
            slotLimit,
        };
        this.activeLeases.set(token, lease);
        log.debug(`Granted OCR resource slot to ${jobId}; active=${this.activeLeases.size}/${this.getActiveSlotLimit()}`);
        return lease;
    }

    private dispatch() {
        while (this.queue.length > 0) {
            const next = this.queue[0];
            if (!next || !this.canGrant(next.slotLimit)) {
                return;
            }
            this.queue.shift();
            next.resolve({
                ...this.createLease(next.request.jobId, next.slotLimit),
                effectiveDpi: next.effectiveDpi,
            });
        }
    }

    private canGrant(candidateSlotLimit: number) {
        if (this.activeLeases.size === 0) {
            return candidateSlotLimit > 0;
        }
        return this.activeLeases.size < Math.min(candidateSlotLimit, this.getActiveSlotLimit());
    }

    private getActiveSlotLimit() {
        if (this.activeLeases.size === 0) {
            return NORMAL_PAGE_SLOTS;
        }
        return Math.min(...Array.from(this.activeLeases.values(), lease => lease.slotLimit));
    }

    private settleQueuedRequests(
        predicate: (item: IQueuedResourceRequest) => boolean,
        reason: string,
    ) {
        const [
            matching,
            remaining,
        ] = partition(this.queue, predicate);
        matching.forEach(item => item.reject(new Error(reason)));
        this.queue = remaining;
    }
}

export const ocrResourceGovernor = new OcrResourceGovernor();
