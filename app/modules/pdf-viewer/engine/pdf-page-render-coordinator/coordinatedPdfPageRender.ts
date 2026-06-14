import type { PDFPageProxy } from 'pdfjs-dist';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

interface ICoordinatedPdfPageRenderTask {
    promise: Promise<unknown>;
    cancel: () => void;
}

interface IActivePdfPageOperation {
    id: number;
    owner: string;
    pageNumber: number;
    priority: number;
    cancel?: (() => void) | undefined;
    settled: Promise<void>;
}

interface IRunCoordinatedPdfPageRenderOptions<TTask extends ICoordinatedPdfPageRenderTask> {
    owner: string;
    pageNumber: number;
    pdfPage: PDFPageProxy;
    priority: number;
    shouldStart?: (() => boolean) | undefined;
    startRender: () => TTask;
    onTask?: ((task: TTask) => void) | undefined;
}

interface IRunCoordinatedPdfPageOperationOptions<TResult> {
    owner: string;
    pageNumber: number;
    pdfPage: PDFPageProxy;
    priority: number;
    shouldStart?: (() => boolean) | undefined;
    operation: () => Promise<TResult>;
}

const activePageOperations = new WeakMap<PDFPageProxy, IActivePdfPageOperation>();
let nextRenderId = 0;

function createCoordinatedRenderCancelledError(pageNumber: number, owner: string) {
    const error = new Error(`Rendering cancelled before coordinated PDF page render for page ${pageNumber} (${owner})`);
    error.name = 'RenderingCancelledException';
    return error;
}

function cancelActiveOperation(activeOperation: IActivePdfPageOperation) {
    if (!activeOperation.cancel) {
        return;
    }

    try {
        activeOperation.cancel();
    } catch {
        // PDF.js cancellation is best-effort and the render promise still settles.
    }
}

async function waitForActiveOperation(
    pdfPage: PDFPageProxy,
    activeOperation: IActivePdfPageOperation,
    owner: string,
    priority: number,
) {
    if (priority > activeOperation.priority && activeOperation.cancel) {
        logPdfRenderTrace('pdf-page-render-coordinator-preempt', {
            pageNumber: activeOperation.pageNumber,
            waitingOwner: owner,
            waitingPriority: priority,
            activeOwner: activeOperation.owner,
            activePriority: activeOperation.priority,
            activeRenderId: activeOperation.id,
        });
        cancelActiveOperation(activeOperation);
    } else {
        logPdfRenderTrace('pdf-page-render-coordinator-wait', {
            pageNumber: activeOperation.pageNumber,
            waitingOwner: owner,
            waitingPriority: priority,
            activeOwner: activeOperation.owner,
            activePriority: activeOperation.priority,
            activeRenderId: activeOperation.id,
        });
    }

    await activeOperation.settled;

    if (activePageOperations.get(pdfPage)?.id === activeOperation.id) {
        activePageOperations.delete(pdfPage);
    }
}

async function waitForCoordinatedTurn(
    pdfPage: PDFPageProxy,
    owner: string,
    priority: number,
) {
    while (true) {
        const activeOperation = activePageOperations.get(pdfPage);
        if (!activeOperation) {
            return;
        }

        await waitForActiveOperation(pdfPage, activeOperation, owner, priority);
    }
}

export async function runCoordinatedPdfPageOperation<TResult>(
    options: IRunCoordinatedPdfPageOperationOptions<TResult>,
) {
    const {
        operation,
        owner,
        pageNumber,
        pdfPage,
        priority,
        shouldStart,
    } = options;

    await waitForCoordinatedTurn(pdfPage, owner, priority);

    if (shouldStart?.() === false) {
        throw createCoordinatedRenderCancelledError(pageNumber, owner);
    }

    const id = ++nextRenderId;
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
        markSettled = resolve;
    });
    activePageOperations.set(pdfPage, {
        id,
        owner,
        pageNumber,
        priority,
        settled,
    });

    try {
        return await operation();
    } finally {
        markSettled();
        if (activePageOperations.get(pdfPage)?.id === id) {
            activePageOperations.delete(pdfPage);
        }
    }
}

export async function runCoordinatedPdfPageRender<TTask extends ICoordinatedPdfPageRenderTask>(
    options: IRunCoordinatedPdfPageRenderOptions<TTask>,
) {
    const {
        onTask,
        owner,
        pageNumber,
        pdfPage,
        priority,
        shouldStart,
        startRender,
    } = options;

    await waitForCoordinatedTurn(pdfPage, owner, priority);

    if (shouldStart?.() === false) {
        throw createCoordinatedRenderCancelledError(pageNumber, owner);
    }

    const task = startRender();
    const id = ++nextRenderId;
    const settled = task.promise
        .catch(() => {})
        .then(() => {
            if (activePageOperations.get(pdfPage)?.id === id) {
                activePageOperations.delete(pdfPage);
            }
        });

    activePageOperations.set(pdfPage, {
        cancel: () => task.cancel(),
        id,
        owner,
        pageNumber,
        priority,
        settled,
    });
    onTask?.(task);

    try {
        await task.promise;
    } finally {
        await settled;
    }
}

export function resetCoordinatedPdfPageRendersForTest() {
    nextRenderId = 0;
}
