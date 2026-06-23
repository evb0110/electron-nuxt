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
const BASE_NORMAL_PAGE_SLOTS = 3;
const MAX_NORMAL_PAGE_SLOTS = 8;
const LOW_MEMORY_PAGE_SLOTS = 2;
const HIGH_DPI_THRESHOLD = 450;
const HIGH_DPI_PAGE_SLOT_COST = 2;

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
    slotCost: number;
}

interface IQueuedResourceRequest {
    request: IOcrResourceRequest;
    effectiveDpi: number;
    slotCost: number;
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

function getCpuSlotCount() {
    const cpuCount = typeof availableParallelism === 'function'
        ? availableParallelism()
        : 2;
    return clamp(Math.floor(cpuCount / 2), 1, MAX_NORMAL_PAGE_SLOTS);
}

function getMemorySlotCount(memoryBytes: number, renderedPageBytes: number) {
    if (memoryBytes <= 0 || renderedPageBytes <= 0) {
        return BASE_NORMAL_PAGE_SLOTS;
    }

    const memoryBudgetRatio = memoryBytes >= 32 * 1024 * MIB
        ? 0.18
        : memoryBytes >= 16 * 1024 * MIB
            ? 0.12
            : 0.08;
    return clamp(
        Math.floor((memoryBytes * memoryBudgetRatio) / renderedPageBytes),
        1,
        MAX_NORMAL_PAGE_SLOTS,
    );
}

function capDpiForPixelBudget(request: IOcrResourceRequest) {
    const requestedPixels = estimateRenderedPixels(request.requestedDpi, request);
    if (requestedPixels <= MAX_RENDERED_PIXELS) {
        return request.requestedDpi;
    }

    const {
        widthIn,
        heightIn,
    } = getPageDimensions(request);
    const pageAreaIn = widthIn * heightIn;
    const estimatedMaxDpi = pageAreaIn > 0
        ? Math.floor(Math.sqrt(MAX_RENDERED_PIXELS / pageAreaIn))
        : 1;
    let effectiveDpi = clamp(estimatedMaxDpi, 1, request.requestedDpi);
    while (effectiveDpi > 1 && estimateRenderedPixels(effectiveDpi, request) > MAX_RENDERED_PIXELS) {
        effectiveDpi -= 1;
    }
    return effectiveDpi;
}

function getGlobalSlotBudget() {
    const configured = parsePositiveInt(process.env.OCR_GLOBAL_PAGE_SLOTS);
    if (configured) {
        return clamp(configured, 1, 8);
    }

    const memoryBytes = totalmem();
    if (memoryBytes > 0 && memoryBytes < LOW_MEMORY_BYTES) {
        return LOW_MEMORY_PAGE_SLOTS;
    }

    const normalRenderedPageBytes = estimateRenderedBytes(300);
    return clamp(
        Math.min(getCpuSlotCount(), getMemorySlotCount(memoryBytes, normalRenderedPageBytes)),
        1,
        MAX_NORMAL_PAGE_SLOTS,
    );
}

function getPageSlotCost(effectiveDpi: number, request: IOcrResourceRequest) {
    const globalSlotBudget = getGlobalSlotBudget();

    const renderedPageBytes = estimateRenderedBytes(effectiveDpi, request);
    if (effectiveDpi >= HIGH_DPI_THRESHOLD || renderedPageBytes > (MAX_RENDERED_PIXELS * BYTES_PER_RGBA_PIXEL) / 2) {
        return Math.min(HIGH_DPI_PAGE_SLOT_COST, globalSlotBudget);
    }

    return 1;
}

class OcrResourceGovernor {
    private activeLeases = new Map<string, IOcrResourceLease>();
    private queue: IQueuedResourceRequest[] = [];
    private tokenCounter = 0;

    async acquire(request: IOcrResourceRequest) {
        const effectiveDpi = capDpiForPixelBudget(request);
        const slotCost = getPageSlotCost(effectiveDpi, request);

        if (effectiveDpi < request.requestedDpi) {
            log.debug(
                `[${request.jobId}] Reducing OCR render DPI for page ${request.pageNumber} from ${request.requestedDpi} to ${effectiveDpi}; estimated pixels would exceed ${MAX_RENDERED_PIXELS}`,
            );
        }

        if (this.queue.length === 0 && this.canGrant(slotCost)) {
            return {
                ...this.createLease(request.jobId, slotCost),
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
                slotCost,
                resolve,
                reject,
            });
            log.debug(
                `[${request.jobId}] Queued OCR resource request for page ${request.pageNumber}; activeSlots=${this.getActiveSlotCost()}/${getGlobalSlotBudget()}, requestCost=${slotCost}, queued=${this.queue.length}`,
            );
            this.dispatch();
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

    private createLease(jobId: string, slotCost: number): IOcrResourceLease {
        const token = `${Date.now()}-${++this.tokenCounter}`;
        const lease = {
            token,
            jobId,
            slotCost,
        };
        this.activeLeases.set(token, lease);
        log.debug(`Granted OCR resource slot to ${jobId}; activeSlots=${this.getActiveSlotCost()}/${getGlobalSlotBudget()}`);
        return lease;
    }

    private dispatch() {
        while (this.queue.length > 0) {
            const grantableIndex = this.queue.findIndex(item => this.canGrant(item.slotCost));
            if (grantableIndex < 0) {
                return;
            }
            const [next] = this.queue.splice(grantableIndex, 1);
            if (!next) {
                return;
            }
            next.resolve({
                ...this.createLease(next.request.jobId, next.slotCost),
                effectiveDpi: next.effectiveDpi,
            });
        }
    }

    private canGrant(candidateSlotCost: number) {
        return candidateSlotCost > 0
            && this.getActiveSlotCost() + candidateSlotCost <= getGlobalSlotBudget();
    }

    private getActiveSlotCost() {
        return Array.from(this.activeLeases.values())
            .reduce((total, lease) => total + lease.slotCost, 0);
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
