import type { WebContents } from 'electron';
import { randomUUID } from 'crypto';
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
    handleDjvuPrintPath,
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
import { cancelConversion } from '@electron/features/djvu/main/ddjvuConversion';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';
import type {
    IDjvuConvertOptions,
    IDjvuPagePreviewOptions,
    IDjvuPrintOptions,
} from '@contracts/electronApiDjvu';
import { normalizeOptionalIpcRequestId } from '@electron/utils/ipcLimits';

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
    requestId: string;
    requestKey: string;
}

interface IDjvuPreviewWaiter extends IDjvuPreviewRequest {
    reject: (error: Error) => void;
    resolve: () => void;
    sequence: number;
}

const previewQueuesBySender = new Map<number, IDjvuPreviewSenderQueue>();
interface IActiveDjvuPreviewOperation {
    abortController: AbortController;
    cancelGroup: string;
    ownerWebContentsId: number;
    request: IDjvuPreviewRequest;
}

const activePreviewOperationsBySenderRequestKey = new Map<string, IActiveDjvuPreviewOperation>();
const activeEstimateOperationsById = new Map<string, {
    abortController: AbortController;
    documentKey: string;
    ownerWebContentsId: number;
}>();
const previewSenderCleanupById = new Map<number, {
    handleDestroyed: () => void;
    handleNavigation: (
        event: Electron.Event,
        url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => void;
    handleRenderProcessGone: () => void;
    sender: WebContents;
}>();
const estimateSenderCleanupById = new Map<number, {
    handleDestroyed: () => void;
    handleNavigation: (
        event: Electron.Event,
        url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => void;
    handleRenderProcessGone: () => void;
    sender: WebContents;
}>();
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

function getActivePreviewOperationKey(ownerWebContentsId: number, requestId: string) {
    return `${ownerWebContentsId}\u0000${requestId}`;
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

function createPreviewRequestId(requestId: string | undefined) {
    const normalizedRequestId = normalizeOptionalIpcRequestId(
        requestId,
        'renderPagePreview.options.previewRequestId',
    );
    return normalizedRequestId ?? `djvu-preview-${randomUUID()}`;
}

function normalizePreviewPriority(priority: number | undefined) {
    return typeof priority === 'number' && Number.isFinite(priority)
        ? priority
        : 0;
}

async function cancelPreviewOperation(ownerWebContentsId: number, requestId: string, reason: string) {
    const active = activePreviewOperationsBySenderRequestKey.get(
        getActivePreviewOperationKey(ownerWebContentsId, requestId),
    );
    if (!active) {
        return false;
    }
    if (!active.abortController.signal.aborted) {
        active.abortController.abort(new Error(reason));
    }
    await cancelConversion(active.cancelGroup);
    return true;
}

function cancelPreviewOperationsForSender(ownerWebContentsId: number, reason: string) {
    for (const active of activePreviewOperationsBySenderRequestKey.values()) {
        if (active.ownerWebContentsId === ownerWebContentsId) {
            void cancelPreviewOperation(ownerWebContentsId, active.request.requestId, reason);
        }
    }
}

function rejectQueuedPreviewWaitersForSender(ownerWebContentsId: number, reason: string) {
    const queue = previewQueuesBySender.get(ownerWebContentsId);
    if (!queue) {
        return;
    }

    for (const waiter of queue.waiters) {
        waiter.reject(new Error(reason));
    }
    queue.waiters = [];
    queue.latestGenerationsByDocument.clear();
    queue.latestRequestIds.clear();
    if (queue.inFlight === 0) {
        previewQueuesBySender.delete(ownerWebContentsId);
    }
}

function unregisterPreviewSenderCleanupIfIdle(ownerWebContentsId: number) {
    for (const active of activePreviewOperationsBySenderRequestKey.values()) {
        if (active.ownerWebContentsId === ownerWebContentsId) {
            return;
        }
    }
    const queue = previewQueuesBySender.get(ownerWebContentsId);
    if (queue && (queue.inFlight > 0 || queue.waiters.length > 0)) {
        return;
    }
    const cleanup = previewSenderCleanupById.get(ownerWebContentsId);
    if (!cleanup) {
        return;
    }
    cleanup.sender.removeListener('destroyed', cleanup.handleDestroyed);
    cleanup.sender.removeListener('render-process-gone', cleanup.handleRenderProcessGone);
    cleanup.sender.removeListener('did-start-navigation', cleanup.handleNavigation);
    previewSenderCleanupById.delete(ownerWebContentsId);
}

function registerPreviewSenderCleanup(sender: WebContents) {
    const ownerWebContentsId = sender.id;
    if (previewSenderCleanupById.has(ownerWebContentsId)) {
        return;
    }
    const cancel = (reason: string) => {
        rejectQueuedPreviewWaitersForSender(ownerWebContentsId, reason);
        cancelPreviewOperationsForSender(ownerWebContentsId, reason);
        unregisterPreviewSenderCleanupIfIdle(ownerWebContentsId);
    };
    const handleDestroyed = () => cancel('Renderer lifecycle ended');
    const handleRenderProcessGone = () => cancel('Renderer lifecycle ended');
    const handleNavigation = (
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (isMainFrame && !isInPlace) {
            cancel('Renderer navigation canceled DjVu preview operations');
        }
    };
    sender.once('destroyed', handleDestroyed);
    sender.once('render-process-gone', handleRenderProcessGone);
    sender.on('did-start-navigation', handleNavigation);
    previewSenderCleanupById.set(ownerWebContentsId, {
        handleDestroyed,
        handleNavigation,
        handleRenderProcessGone,
        sender,
    });
}

function cancelEstimateOperationsForSender(
    ownerWebContentsId: number,
    reason: string,
    exceptDocumentKey?: string,
) {
    for (const [
        operationId,
        active,
    ] of activeEstimateOperationsById.entries()) {
        if (active.ownerWebContentsId !== ownerWebContentsId) {
            continue;
        }
        if (exceptDocumentKey !== undefined && active.documentKey === exceptDocumentKey) {
            continue;
        }
        if (!active.abortController.signal.aborted) {
            active.abortController.abort(new Error(reason));
        }
        activeEstimateOperationsById.delete(operationId);
    }
}

function unregisterEstimateSenderCleanupIfIdle(ownerWebContentsId: number) {
    for (const active of activeEstimateOperationsById.values()) {
        if (active.ownerWebContentsId === ownerWebContentsId) {
            return;
        }
    }
    const cleanup = estimateSenderCleanupById.get(ownerWebContentsId);
    if (!cleanup) {
        return;
    }
    cleanup.sender.removeListener('destroyed', cleanup.handleDestroyed);
    cleanup.sender.removeListener('render-process-gone', cleanup.handleRenderProcessGone);
    cleanup.sender.removeListener('did-start-navigation', cleanup.handleNavigation);
    estimateSenderCleanupById.delete(ownerWebContentsId);
}

function registerEstimateSenderCleanup(sender: WebContents) {
    const ownerWebContentsId = sender.id;
    if (estimateSenderCleanupById.has(ownerWebContentsId)) {
        return;
    }
    const cancel = (reason: string) => {
        cancelEstimateOperationsForSender(ownerWebContentsId, reason);
        unregisterEstimateSenderCleanupIfIdle(ownerWebContentsId);
    };
    const handleDestroyed = () => cancel('Renderer lifecycle ended');
    const handleRenderProcessGone = () => cancel('Renderer lifecycle ended');
    const handleNavigation = (
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (isMainFrame && !isInPlace) {
            cancel('Renderer navigation canceled DjVu estimate operations');
        }
    };
    sender.once('destroyed', handleDestroyed);
    sender.once('render-process-gone', handleRenderProcessGone);
    sender.on('did-start-navigation', handleNavigation);
    estimateSenderCleanupById.set(ownerWebContentsId, {
        handleDestroyed,
        handleNavigation,
        handleRenderProcessGone,
        sender,
    });
}

function cancelSupersededActivePreviewOperations(queue: IDjvuPreviewSenderQueue, ownerWebContentsId: number) {
    for (const active of activePreviewOperationsBySenderRequestKey.values()) {
        if (
            active.ownerWebContentsId === ownerWebContentsId
            && isPreviewRequestSuperseded(queue, active.request)
        ) {
            void cancelPreviewOperation(
                ownerWebContentsId,
                active.request.requestId,
                'DjVu preview request superseded',
            );
        }
    }
}

function recordPreviewRequest(queue: IDjvuPreviewSenderQueue, ownerWebContentsId: number, request: IDjvuPreviewRequest) {
    queue.latestRequestIds.set(request.requestKey, request.requestId);

    const generation = parsePreviewRequestGeneration(request.requestId);
    if (generation !== null) {
        queue.latestGenerationsByDocument.set(
            request.documentKey,
            Math.max(queue.latestGenerationsByDocument.get(request.documentKey) ?? generation, generation),
        );
    }

    cancelSupersededActivePreviewOperations(queue, ownerWebContentsId);
}

function isPreviewRequestSuperseded(queue: IDjvuPreviewSenderQueue, request: IDjvuPreviewRequest) {
    if (queue.latestRequestIds.get(request.requestKey) !== request.requestId) {
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
    sender: WebContents,
    documentKey: string,
    requestKey: string,
    requestId: string,
    priority: number,
    render: (
        operation: {
            cancelGroup: string;
            signal: AbortSignal;
        },
    ) => Promise<TResult>,
) {
    const senderId = sender.id;
    const queue = getPreviewQueue(senderId);
    const request: IDjvuPreviewRequest = {
        documentKey,
        priority,
        requestId,
        requestKey,
    };
    recordPreviewRequest(queue, senderId, request);

    if (isPreviewRequestSuperseded(queue, request)) {
        throw new Error('DjVu preview request superseded');
    }

    const acquiredSlot = acquirePreviewSlot(queue, request);
    if (acquiredSlot !== true) {
        await acquiredSlot;
    }
    try {
        if (sender.isDestroyed?.() === true) {
            throw new Error('DjVu preview operation canceled');
        }
        if (isPreviewRequestSuperseded(queue, request)) {
            throw new Error('DjVu preview request superseded');
        }
        const abortController = new AbortController();
        const operationKey = getActivePreviewOperationKey(senderId, request.requestId);
        const cancelGroup = `djvu-preview:${senderId}:${request.requestId}`;
        const mainOperation = registerMainOperation({
            kind: 'abortable-work',
            ownerWebContentsId: senderId,
            workingCopyPath: documentKey,
            cancel: (reason) => {
                abortController.abort(new Error(reason));
                void cancelConversion(cancelGroup);
            },
        });
        registerPreviewSenderCleanup(sender);
        const activeOperation: IActiveDjvuPreviewOperation = {
            abortController,
            cancelGroup,
            ownerWebContentsId: senderId,
            request,
        };
        activePreviewOperationsBySenderRequestKey.set(operationKey, activeOperation);
        const abortMainOperation = () => {
            if (!abortController.signal.aborted) {
                abortController.abort(new Error('DjVu preview operation canceled'));
            }
            void cancelConversion(cancelGroup);
        };
        mainOperation.signal.addEventListener('abort', abortMainOperation, { once: true });
        try {
            return await render({
                cancelGroup,
                signal: abortController.signal,
            });
        } finally {
            mainOperation.signal.removeEventListener('abort', abortMainOperation);
            if (activePreviewOperationsBySenderRequestKey.get(operationKey) === activeOperation) {
                activePreviewOperationsBySenderRequestKey.delete(operationKey);
            }
            mainOperation.complete();
        }
    } finally {
        if (queue.latestRequestIds.get(requestKey) === requestId) {
            queue.latestRequestIds.delete(requestKey);
        }
        releasePreviewSlot(senderId, queue);
        unregisterPreviewSenderCleanupIfIdle(senderId);
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

export function handleDjvuPrintPathOperation(
    context: IDjvuOperationContext,
    djvuPath: string,
    options: IDjvuPrintOptions,
) {
    return handleDjvuPrintPath(
        context,
        requireDjvuOpenPath(djvuPath, context.sender),
        options,
    );
}

export function handleDjvuCancelOperation(
    context: IDjvuOperationContext,
    jobId: string,
) {
    return handleDjvuCancel(context, jobId);
}

export async function handleDjvuCancelPagePreview(
    context: IDjvuOperationContext,
    requestId: string,
) {
    const normalizedRequestId = normalizeOptionalIpcRequestId(requestId, 'cancelPagePreview.requestId') ?? '';
    if (!normalizedRequestId) {
        return { canceled: false };
    }

    const active = activePreviewOperationsBySenderRequestKey.get(
        getActivePreviewOperationKey(context.senderId, normalizedRequestId),
    );
    if (!active) {
        return { canceled: false };
    }
    const canceled = await cancelPreviewOperation(
        context.senderId,
        normalizedRequestId,
        'DjVu preview request canceled',
    );
    return { canceled };
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
    cancelEstimateOperationsForSender(
        context.senderId,
        'DjVu estimate request superseded',
        normalizedDjvuPath,
    );

    const abortController = new AbortController();
    const operationId = `djvu-estimate-${randomUUID()}`;
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath: normalizedDjvuPath,
        cancel: (reason) => {
            if (!abortController.signal.aborted) {
                abortController.abort(new Error(reason));
            }
        },
    });
    const abortMainOperation = () => {
        if (!abortController.signal.aborted) {
            abortController.abort(new Error('DjVu estimate operation canceled'));
        }
    };

    activeEstimateOperationsById.set(operationId, {
        abortController,
        documentKey: normalizedDjvuPath,
        ownerWebContentsId: context.senderId,
    });
    registerEstimateSenderCleanup(context.sender);
    mainOperation.signal.addEventListener('abort', abortMainOperation, { once: true });
    try {
        const pageCount = await getDjvuPageCount(normalizedDjvuPath, { signal: abortController.signal });
        return await estimateSizes(normalizedDjvuPath, pageCount, { signal: abortController.signal });
    } finally {
        mainOperation.signal.removeEventListener('abort', abortMainOperation);
        activeEstimateOperationsById.delete(operationId);
        unregisterEstimateSenderCleanupIfIdle(context.senderId);
        mainOperation.complete();
    }
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
    const previewRequestId = createPreviewRequestId(options?.previewRequestId);
    return runCoalescedPreviewRequest(
        context.sender,
        normalizedDjvuPath,
        getPreviewRequestKey(normalizedDjvuPath, pageNumber),
        previewRequestId,
        normalizePreviewPriority(options?.previewPriority),
        operation => renderDjvuPagePreview(normalizedDjvuPath, pageNumber, {
            ...options,
            previewRequestId,
        }, operation),
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
