import type { WebContents } from 'electron';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { estimateSizes } from '@electron/djvu/estimateSizes';
import {
    getDjvuHasText,
    getDjvuMetadata,
    getDjvuOutline,
    getDjvuPageCount,
    getDjvuResolution,
} from '@electron/djvu/metadata';
import { parseDjvuOutline } from '@electron/djvu/parseDjvuOutline';
import {
    handleDjvuCancel,
    handleDjvuConvertToPdf,
} from '@electron/features/djvu/main/pdfExport';
import { createLogger } from '@electron/utils/createLogger';
import {
    cleanupDjvuTempPdfPath,
    handleDjvuOpenForViewing,
    isAllowedDjvuViewingPath,
    releaseDjvuViewingPath,
} from '@electron/features/djvu/main/viewing';
import {
    getDjvuPageSizesForViewing,
    renderDjvuPagePreview,
} from '@electron/features/djvu/main/pagePreview';
import { isDjvuPath } from '@electron/image/pdfConversion';
import {
    requireOpenPath,
    type TOpenPath,
} from '@electron/file-access/openPathCapabilities';
import { normalizePossiblyEncodedExistingPath } from '@electron/utils/normalizePossiblyEncodedExistingPath';
import type { IDjvuOperationContext } from '@electron/features/djvu/ports';
import type {
    IDjvuConvertOptions,
    IDjvuPagePreviewOptions,
} from '@contracts/electronApiDjvu';

const logger = createLogger('djvu-operations');
const DJVU_PREVIEW_MAX_IN_FLIGHT_PER_SENDER = 2;

interface IDjvuPreviewSenderQueue {
    inFlight: number;
    latestGenerationsByDocument: Map<string, number>;
    latestRequestIds: Map<string, string>;
    waiters: IDjvuPreviewWaiter[];
}

interface IDjvuPreviewRequest {
    documentKey: string;
    priority: number;
    requestId: string | undefined;
    requestKey: string;
}

interface IDjvuPreviewWaiter extends IDjvuPreviewRequest {
    reject: (error: Error) => void;
    resolve: () => void;
    sequence: number;
}

const previewQueuesBySender = new Map<number, IDjvuPreviewSenderQueue>();
let nextPreviewWaiterSequence = 0;

function getPreviewQueue(senderId: number) {
    const existingQueue = previewQueuesBySender.get(senderId);
    if (existingQueue) {
        return existingQueue;
    }

    const queue: IDjvuPreviewSenderQueue = {
        inFlight: 0,
        latestGenerationsByDocument: new Map(),
        latestRequestIds: new Map(),
        waiters: [],
    };
    previewQueuesBySender.set(senderId, queue);
    return queue;
}

function getPreviewRequestKey(djvuPath: string, pageNumber: number) {
    return `${djvuPath}\u0000${pageNumber}`;
}

function parsePreviewRequestGeneration(requestId: string | undefined) {
    if (!requestId) {
        return null;
    }

    const generationText = requestId.match(/^(\d+):\d+:\d+$/u)?.[1];
    if (!generationText) {
        return null;
    }

    const generation = Number.parseInt(generationText, 10);
    return Number.isSafeInteger(generation) ? generation : null;
}

function normalizePreviewPriority(priority: number | undefined) {
    return typeof priority === 'number' && Number.isFinite(priority)
        ? priority
        : 0;
}

function recordPreviewRequest(queue: IDjvuPreviewSenderQueue, request: IDjvuPreviewRequest) {
    if (request.requestId) {
        queue.latestRequestIds.set(request.requestKey, request.requestId);
    }

    const generation = parsePreviewRequestGeneration(request.requestId);
    if (generation === null) {
        return;
    }

    queue.latestGenerationsByDocument.set(
        request.documentKey,
        Math.max(queue.latestGenerationsByDocument.get(request.documentKey) ?? generation, generation),
    );
}

function isPreviewRequestSuperseded(queue: IDjvuPreviewSenderQueue, request: IDjvuPreviewRequest) {
    if (request.requestId && queue.latestRequestIds.get(request.requestKey) !== request.requestId) {
        return true;
    }

    const generation = parsePreviewRequestGeneration(request.requestId);
    return generation !== null
        && generation < (queue.latestGenerationsByDocument.get(request.documentKey) ?? generation);
}

function findNextPreviewWaiterIndex(queue: IDjvuPreviewSenderQueue) {
    let selectedIndex = -1;
    let selectedWaiter: IDjvuPreviewWaiter | null = null;

    for (let index = 0; index < queue.waiters.length; index += 1) {
        const waiter = queue.waiters[index];
        if (!waiter || isPreviewRequestSuperseded(queue, waiter)) {
            continue;
        }
        if (
            !selectedWaiter
            || waiter.priority > selectedWaiter.priority
            || (waiter.priority === selectedWaiter.priority && waiter.sequence < selectedWaiter.sequence)
        ) {
            selectedIndex = index;
            selectedWaiter = waiter;
        }
    }

    return selectedIndex;
}

function rejectSupersededPreviewWaiters(queue: IDjvuPreviewSenderQueue) {
    const remainingWaiters: IDjvuPreviewWaiter[] = [];
    for (const waiter of queue.waiters) {
        if (isPreviewRequestSuperseded(queue, waiter)) {
            waiter.reject(new Error('DjVu preview request superseded'));
        } else {
            remainingWaiters.push(waiter);
        }
    }
    queue.waiters = remainingWaiters;
}

function drainPreviewQueue(queue: IDjvuPreviewSenderQueue) {
    rejectSupersededPreviewWaiters(queue);

    while (queue.inFlight < DJVU_PREVIEW_MAX_IN_FLIGHT_PER_SENDER && queue.waiters.length > 0) {
        const nextWaiterIndex = findNextPreviewWaiterIndex(queue);
        if (nextWaiterIndex < 0) {
            return;
        }

        const [nextWaiter] = queue.waiters.splice(nextWaiterIndex, 1);
        if (!nextWaiter) {
            return;
        }
        queue.inFlight += 1;
        nextWaiter.resolve();
        rejectSupersededPreviewWaiters(queue);
    }
}

function acquirePreviewSlot(queue: IDjvuPreviewSenderQueue, request: IDjvuPreviewRequest) {
    rejectSupersededPreviewWaiters(queue);
    if (queue.inFlight < DJVU_PREVIEW_MAX_IN_FLIGHT_PER_SENDER && queue.waiters.length === 0) {
        queue.inFlight += 1;
        return true;
    }

    return new Promise<void>((resolve, reject) => {
        nextPreviewWaiterSequence += 1;
        queue.waiters.push({
            ...request,
            resolve,
            reject,
            sequence: nextPreviewWaiterSequence,
        });
        drainPreviewQueue(queue);
    });
}

function releasePreviewSlot(senderId: number, queue: IDjvuPreviewSenderQueue) {
    queue.inFlight = Math.max(0, queue.inFlight - 1);
    drainPreviewQueue(queue);
    if (queue.inFlight === 0 && queue.waiters.length === 0 && queue.latestRequestIds.size === 0) {
        previewQueuesBySender.delete(senderId);
    }
}

async function runCoalescedPreviewRequest<TResult>(
    senderId: number,
    documentKey: string,
    requestKey: string,
    requestId: string | undefined,
    priority: number,
    render: () => Promise<TResult>,
) {
    const queue = getPreviewQueue(senderId);
    const request: IDjvuPreviewRequest = {
        documentKey,
        priority,
        requestId,
        requestKey,
    };
    recordPreviewRequest(queue, request);

    if (isPreviewRequestSuperseded(queue, request)) {
        throw new Error('DjVu preview request superseded');
    }

    const acquiredSlot = acquirePreviewSlot(queue, request);
    if (acquiredSlot !== true) {
        await acquiredSlot;
    }
    try {
        if (isPreviewRequestSuperseded(queue, request)) {
            throw new Error('DjVu preview request superseded');
        }
        return await render();
    } finally {
        if (requestId && queue.latestRequestIds.get(requestKey) === requestId) {
            queue.latestRequestIds.delete(requestKey);
        }
        releasePreviewSlot(senderId, queue);
    }
}

function requireDjvuOpenPath(
    path: unknown,
    owner?: WebContents,
    options: { requireExists?: boolean } = {},
): TOpenPath {
    const rawPath = typeof path === 'string' ? path.trim() : '';
    const normalizedPath = rawPath
        ? (normalizePossiblyEncodedExistingPath(rawPath) ?? rawPath)
        : '';
    if (!normalizedPath) {
        throw new Error('Invalid DjVu path');
    }
    if (!isDjvuPath(normalizedPath)) {
        throw new Error('Invalid DjVu file type');
    }
    if (options.requireExists !== false && !existsSync(normalizedPath)) {
        throw new Error(`DjVu file not found: ${normalizedPath}`);
    }
    return requireOpenPath(normalizedPath, owner);
}

function normalizeDjvuReleasePath(path: unknown, owner?: WebContents) {
    const normalizedPath = typeof path === 'string' ? path.trim() : '';
    if (!normalizedPath) {
        throw new Error('Invalid DjVu path');
    }
    if (!isDjvuPath(normalizedPath)) {
        throw new Error('Invalid DjVu file type');
    }
    try {
        return requireOpenPath(normalizedPath, owner);
    } catch {
        // The file may have been moved after opening; fall back to the renderer-held path for cleanup.
    }
    return resolve(normalizedPath);
}

export function handleDjvuOpenForViewingOperation(
    context: IDjvuOperationContext,
    djvuPath: string,
) {
    return handleDjvuOpenForViewing(
        context,
        requireDjvuOpenPath(djvuPath, context.sender),
    );
}

export function handleDjvuReleaseViewingPath(
    context: IDjvuOperationContext,
    djvuPath: string,
) {
    releaseDjvuViewingPath(
        context,
        normalizeDjvuReleasePath(djvuPath, context.sender),
    );
}

export function handleDjvuConvertToPdfOperation(
    context: IDjvuOperationContext,
    djvuPath: string,
    outputPath: string,
    options: IDjvuConvertOptions,
) {
    return handleDjvuConvertToPdf(
        context,
        requireDjvuOpenPath(djvuPath, context.sender),
        outputPath,
        options,
    );
}

export function handleDjvuCancelOperation(
    context: IDjvuOperationContext,
    jobId: string,
) {
    return handleDjvuCancel(context, jobId);
}

export async function handleDjvuGetInfo(
    context: IDjvuOperationContext,
    djvuPath: string,
): Promise<{
    pageCount: number;
    sourceDpi: number;
    hasBookmarks: boolean;
    hasText: boolean;
    metadata: Record<string, string>;
}> {
    const normalizedDjvuPath = requireDjvuOpenPath(djvuPath, context.sender);
    const [
        pageCount,
        sourceDpi,
        outlineSexp,
        hasText,
        metadata,
    ] = await Promise.all([
        getDjvuPageCount(normalizedDjvuPath),
        getDjvuResolution(normalizedDjvuPath),
        getDjvuOutline(normalizedDjvuPath),
        getDjvuHasText(normalizedDjvuPath),
        getDjvuMetadata(normalizedDjvuPath),
    ]);

    const bookmarks = parseDjvuOutline(outlineSexp);

    return {
        pageCount,
        sourceDpi,
        hasBookmarks: bookmarks.length > 0,
        hasText,
        metadata,
    };
}

export async function handleDjvuEstimateSizes(
    context: IDjvuOperationContext,
    djvuPath: string,
) {
    const normalizedDjvuPath = requireDjvuOpenPath(djvuPath, context.sender);
    const pageCount = await getDjvuPageCount(normalizedDjvuPath);
    return estimateSizes(normalizedDjvuPath, pageCount);
}

export async function handleDjvuGetPageSizes(
    context: IDjvuOperationContext,
    djvuPath: string,
) {
    const normalizedDjvuPath = requireDjvuOpenPath(djvuPath, context.sender);
    if (!isAllowedDjvuViewingPath(normalizedDjvuPath, context.senderId)) {
        throw new Error('DjVu viewing path is not active');
    }
    const pageCount = await getDjvuPageCount(normalizedDjvuPath);
    return getDjvuPageSizesForViewing(normalizedDjvuPath, pageCount);
}

export async function handleDjvuRenderPagePreview(
    context: IDjvuOperationContext,
    djvuPath: string,
    pageNumber: number,
    options?: IDjvuPagePreviewOptions,
) {
    const normalizedDjvuPath = requireDjvuOpenPath(djvuPath, context.sender);
    if (!isAllowedDjvuViewingPath(normalizedDjvuPath, context.senderId)) {
        throw new Error('DjVu viewing path is not active');
    }
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        throw new Error(`Invalid DjVu page number: ${pageNumber}`);
    }
    return runCoalescedPreviewRequest(
        context.senderId,
        normalizedDjvuPath,
        getPreviewRequestKey(normalizedDjvuPath, pageNumber),
        options?.previewRequestId,
        normalizePreviewPriority(options?.previewPriority),
        () => renderDjvuPagePreview(normalizedDjvuPath, pageNumber, options),
    );
}

export async function handleDjvuCleanupTemp(
    _context: IDjvuOperationContext,
    tempPdfPath: string,
) {
    if (!tempPdfPath) {
        return;
    }

    try {
        await cleanupDjvuTempPdfPath(tempPdfPath);
    } catch (error) {
        logger.warn(`Failed to cleanup temporary DjVu PDF: ${String(error)}`);
    }
}
