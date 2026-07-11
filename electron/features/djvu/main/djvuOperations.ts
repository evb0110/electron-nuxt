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
import { mainJobBroker } from '@electron/resources/jobBroker';
import {
    awaitDurableDjvuConvertJob,
    awaitDurableDjvuOpenJob,
    cancelDurableDjvuJob,
    startDurableDjvuConvertJob,
    startDurableDjvuOpenJob,
} from '@electron/features/djvu/main/durableDjvuJobs';

const logger = createLogger('djvu-operations');
const DJVU_PREVIEW_MAX_IN_FLIGHT_PER_SENDER = 2;

interface IDjvuPreviewSenderState {
    latestGenerationsByDocument: Map<string, number>;
    latestRequestIds: Map<string, string>;
    reservedRequestIds: Set<string>;
    pendingRequests: Map<string, {
        abortController: AbortController;
        request: IDjvuPreviewRequest
    }>;
}

interface IDjvuPreviewRequest {
    documentKey: string;
    priority: number;
    requestId: string;
    requestKey: string;
}

const previewStateBySender = new Map<number, IDjvuPreviewSenderState>();
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
function getPreviewState(senderId: number) {
    const existingState = previewStateBySender.get(senderId);
    if (existingState) {
        return existingState;
    }

    const state: IDjvuPreviewSenderState = {
        latestGenerationsByDocument: new Map(),
        latestRequestIds: new Map(),
        reservedRequestIds: new Set(),
        pendingRequests: new Map(),
    };
    previewStateBySender.set(senderId, state);
    return state;
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

function clearPreviewStateForSender(ownerWebContentsId: number) {
    const state = previewStateBySender.get(ownerWebContentsId);
    if (!state) {
        return;
    }
    state.latestGenerationsByDocument.clear();
    state.latestRequestIds.clear();
    state.reservedRequestIds.clear();
    for (const pending of state.pendingRequests.values()) {
        pending.abortController.abort(new Error('Renderer lifecycle ended'));
    }
    state.pendingRequests.clear();
    previewStateBySender.delete(ownerWebContentsId);
    mainJobBroker.cancelOwner(`djvu-preview:${ownerWebContentsId}`, 'Renderer lifecycle ended');
}

function unregisterPreviewSenderCleanupIfIdle(ownerWebContentsId: number) {
    for (const active of activePreviewOperationsBySenderRequestKey.values()) {
        if (active.ownerWebContentsId === ownerWebContentsId) {
            return;
        }
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
        clearPreviewStateForSender(ownerWebContentsId);
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

function cancelSupersededActivePreviewOperations(state: IDjvuPreviewSenderState, ownerWebContentsId: number) {
    for (const active of activePreviewOperationsBySenderRequestKey.values()) {
        if (
            active.ownerWebContentsId === ownerWebContentsId
            && isPreviewRequestSuperseded(state, active.request)
        ) {
            void cancelPreviewOperation(
                ownerWebContentsId,
                active.request.requestId,
                'DjVu preview request superseded',
            );
        }
    }
}

function recordPreviewRequest(state: IDjvuPreviewSenderState, ownerWebContentsId: number, request: IDjvuPreviewRequest) {
    state.latestRequestIds.set(request.requestKey, request.requestId);

    const generation = parsePreviewRequestGeneration(request.requestId);
    if (generation !== null) {
        state.latestGenerationsByDocument.set(
            request.documentKey,
            Math.max(state.latestGenerationsByDocument.get(request.documentKey) ?? generation, generation),
        );
    }

    for (const [
        pendingRequestId,
        pending,
    ] of state.pendingRequests) {
        if (
            !state.reservedRequestIds.has(pendingRequestId)
            && pendingRequestId !== request.requestId
            && isPreviewRequestSuperseded(state, pending.request)
        ) {
            pending.abortController.abort(new Error('DjVu preview request superseded'));
            state.pendingRequests.delete(pendingRequestId);
        }
    }

    cancelSupersededActivePreviewOperations(state, ownerWebContentsId);
}

function isPreviewRequestSuperseded(state: IDjvuPreviewSenderState, request: IDjvuPreviewRequest) {
    if (state.latestRequestIds.get(request.requestKey) !== request.requestId) {
        return true;
    }

    const generation = parsePreviewRequestGeneration(request.requestId);
    return generation !== null
        && generation < (state.latestGenerationsByDocument.get(request.documentKey) ?? generation);
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
    const state = getPreviewState(senderId);
    const request: IDjvuPreviewRequest = {
        documentKey,
        priority,
        requestId,
        requestKey,
    };
    const hasImmediateReservation = state.reservedRequestIds.size < DJVU_PREVIEW_MAX_IN_FLIGHT_PER_SENDER;
    if (hasImmediateReservation) {
        state.reservedRequestIds.add(requestId);
    }
    const abortController = new AbortController();
    state.pendingRequests.set(requestId, {
        abortController,
        request,
    });
    recordPreviewRequest(state, senderId, request);

    if (!hasImmediateReservation && isPreviewRequestSuperseded(state, request)) {
        throw new Error('DjVu preview request superseded');
    }

    const brokerLease = await mainJobBroker.acquire({
        ownerId: `djvu-preview:${senderId}`,
        kind: 'djvu-preview',
        priority: priority >= 10 ? 'visible' : priority > 0 ? 'foreground' : 'background',
        perOwnerLimit: DJVU_PREVIEW_MAX_IN_FLIGHT_PER_SENDER,
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes: 64 * 1024 * 1024,
            nativeProcesses: 1,
            ioWeight: 1,
        },
        signal: abortController.signal,
    }).catch((error: unknown) => {
        state.reservedRequestIds.delete(requestId);
        state.pendingRequests.delete(requestId);
        throw error;
    });
    state.pendingRequests.delete(requestId);
    try {
        if (sender.isDestroyed?.() === true) {
            throw new Error('DjVu preview operation canceled');
        }
        if (!hasImmediateReservation && isPreviewRequestSuperseded(state, request)) {
            throw new Error('DjVu preview request superseded');
        }
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
        brokerLease.release();
        state.reservedRequestIds.delete(requestId);
        state.pendingRequests.delete(requestId);
        if (state.latestRequestIds.get(requestKey) === requestId) {
            state.latestRequestIds.delete(requestKey);
        }
        if (state.latestRequestIds.size === 0 && state.reservedRequestIds.size === 0) {
            previewStateBySender.delete(senderId);
        }
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

export function handleDjvuStartOpenForViewingOperation(
    context: IDjvuOperationContext,
    djvuPath: string,
    requestId: string,
) {
    const checkedRequestId = normalizeOptionalIpcRequestId(requestId, 'startOpenForViewing.requestId');
    if (!checkedRequestId) {
        throw new Error('startOpenForViewing.requestId is required');
    }
    const path = requireDjvuOpenPath(djvuPath, context.sender);
    const jobId = `djvu-open-${context.senderId}-${checkedRequestId}`;
    startDurableDjvuOpenJob(
        jobId,
        path,
        signal => handleDjvuOpenForViewing(context, path, signal, false),
    );
    return Promise.resolve({
        jobId,
        requestId: checkedRequestId,
    });
}

export function handleDjvuAwaitOpenJobOperation(context: IDjvuOperationContext, jobId: string) {
    return awaitDurableDjvuOpenJob(context, jobId.trim());
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

export function handleDjvuStartConvertToPdfOperation(
    context: IDjvuOperationContext,
    djvuPath: string,
    outputPath: string,
    options: IDjvuConvertOptions,
) {
    const requestId = normalizeOptionalIpcRequestId(options.requestId, 'startConvertToPdf.options.requestId');
    if (!requestId) {
        throw new Error('startConvertToPdf.options.requestId is required');
    }
    const jobId = `djvu-convert-${context.senderId}-${requestId}`;
    const path = requireDjvuOpenPath(djvuPath, context.sender);
    startDurableDjvuConvertJob(
        jobId,
        () => handleDjvuConvertToPdf(context, path, outputPath, {
            ...options,
            jobId,
        }, {cancelOnSenderGone: false}),
    );
    return Promise.resolve({
        jobId,
        requestId,
    });
}

export function handleDjvuAwaitConvertJobOperation(context: IDjvuOperationContext, jobId: string) {
    return awaitDurableDjvuConvertJob(context, jobId.trim());
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

export async function handleDjvuCancelOperation(
    context: IDjvuOperationContext,
    jobId: string,
) {
    const durableCanceled = cancelDurableDjvuJob(jobId.trim());
    const activeResult = await handleDjvuCancel(context, jobId);
    return { canceled: durableCanceled || activeResult.canceled };
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
