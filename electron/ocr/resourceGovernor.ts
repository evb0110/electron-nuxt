import {
    availableParallelism,
    totalmem,
} from 'os';
import { clamp } from 'es-toolkit/math';
import { createLogger } from '@electron/utils/logger';

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

interface IOcrResourceRequest {
    jobId: string;
    pageNumber: number;
    requestedDpi: number;
    pageWidthIn?: number;
    pageHeightIn?: number;
}

interface IOcrResourceLease {
    token: string;
    jobId: string;
}

interface IQueuedResourceRequest {
    request: IOcrResourceRequest;
    resolve: (lease: IOcrResourceLease & { effectiveDpi: number }) => void;
}

function parsePositiveInt(value: string | undefined): number | null {
    if (!value) {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
}

function getSystemMemoryBytes() {
    return totalmem();
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

    const memoryBytes = getSystemMemoryBytes();
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
    private currentSlotLimit = NORMAL_PAGE_SLOTS;

    async acquire(request: IOcrResourceRequest) {
        const effectiveDpi = capDpiForPixelBudget(request);
        const requestedSlots = getDefaultSlotCount(effectiveDpi, request);
        this.currentSlotLimit = Math.min(this.currentSlotLimit, requestedSlots);

        if (effectiveDpi < request.requestedDpi) {
            log.debug(
                `[${request.jobId}] Reducing OCR render DPI for page ${request.pageNumber} from ${request.requestedDpi} to ${effectiveDpi}; estimated pixels would exceed ${MAX_RENDERED_PIXELS}`,
            );
        }

        if (this.activeLeases.size < this.currentSlotLimit) {
            return {
                ...this.createLease(request.jobId),
                effectiveDpi,
            };
        }

        return new Promise<IOcrResourceLease & { effectiveDpi: number }>((resolve) => {
            this.queue.push({
                request: {
                    ...request,
                    requestedDpi: effectiveDpi,
                },
                resolve,
            });
            log.debug(
                `[${request.jobId}] Queued OCR resource request for page ${request.pageNumber}; active=${this.activeLeases.size}/${this.currentSlotLimit}, queued=${this.queue.length}`,
            );
        });
    }

    release(token: string) {
        if (!this.activeLeases.delete(token)) {
            return;
        }
        this.dispatch();
    }

    releaseJob(jobId: string) {
        for (const [
            token,
            lease,
        ] of this.activeLeases.entries()) {
            if (lease.jobId === jobId) {
                this.activeLeases.delete(token);
            }
        }

        this.queue = this.queue.filter(item => item.request.jobId !== jobId);
        this.dispatch();
    }

    reset() {
        this.activeLeases.clear();
        this.queue = [];
        this.currentSlotLimit = NORMAL_PAGE_SLOTS;
    }

    private createLease(jobId: string): IOcrResourceLease {
        const token = `${Date.now()}-${++this.tokenCounter}`;
        const lease = {
            token,
            jobId,
        };
        this.activeLeases.set(token, lease);
        log.debug(`Granted OCR resource slot to ${jobId}; active=${this.activeLeases.size}/${this.currentSlotLimit}`);
        return lease;
    }

    private dispatch() {
        while (this.queue.length > 0 && this.activeLeases.size < this.currentSlotLimit) {
            const next = this.queue.shift();
            if (!next) {
                return;
            }
            next.resolve({
                ...this.createLease(next.request.jobId),
                effectiveDpi: next.request.requestedDpi,
            });
        }

        if (this.activeLeases.size === 0 && this.queue.length === 0) {
            this.currentSlotLimit = NORMAL_PAGE_SLOTS;
        }
    }
}

export const ocrResourceGovernor = new OcrResourceGovernor();
