import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';
import {
    runCoordinatedPdfPageOperation,
    runCoordinatedPdfPageRender,
} from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import { cast } from '@tests/helpers/cast';

async function flushAsync() {
    await new Promise<void>(resolve => setImmediate(resolve));
}

function createCancelledRenderError() {
    const error = new Error('Rendering cancelled');
    error.name = 'RenderingCancelledException';
    return error;
}

function createRenderTask(options: { settleOnCancel?: boolean } = {}) {
    let resolveTask!: () => void;
    let rejectTask!: (error: unknown) => void;
    let settled = false;
    const promise = new Promise<void>((resolve, reject) => {
        resolveTask = () => {
            settled = true;
            resolve();
        };
        rejectTask = (error: unknown) => {
            settled = true;
            reject(error);
        };
    });
    return {
        promise,
        cancel: vi.fn(() => {
            if (!settled && options.settleOnCancel !== false) {
                rejectTask(createCancelledRenderError());
            }
        }),
        resolve: resolveTask,
    };
}

function createDeferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });

    return {
        promise,
        reject,
        resolve,
    };
}

describe('runCoordinatedPdfPageRender', () => {
    it.each([
        {
            waitingPriority: 100,
            priorityRelationship: 'equal',
        },
        {
            waitingPriority: 10,
            priorityRelationship: 'lower',
        },
    ])('claims same-page render ownership before a $priorityRelationship-priority synchronous caller can overlap', async ({ waitingPriority }) => {
        const page = cast<PDFPageProxy>({ pageNumber: 1 });
        const events: string[] = [];
        const firstTask = createRenderTask();
        const secondTask = createRenderTask();

        const firstRun = runCoordinatedPdfPageRender({
            owner: 'first',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            startRender: () => {
                events.push('start first');
                return firstTask;
            },
        });
        const secondRun = runCoordinatedPdfPageRender({
            owner: 'second',
            pageNumber: 1,
            pdfPage: page,
            priority: waitingPriority,
            startRender: () => {
                events.push('start second');
                return secondTask;
            },
        });

        await flushAsync();
        expect(events).toEqual(['start first']);
        expect(firstTask.cancel).not.toHaveBeenCalled();

        firstTask.resolve();
        await firstRun;
        await flushAsync();
        expect(events).toEqual([
            'start first',
            'start second',
        ]);

        secondTask.resolve();
        await secondRun;
    });

    it('claims same-page operation ownership before synchronous callers can overlap', async () => {
        const page = cast<PDFPageProxy>({ pageNumber: 1 });
        const events: string[] = [];
        const firstOperation = createDeferred<string>();
        const secondOperation = createDeferred<string>();

        const firstRun = runCoordinatedPdfPageOperation({
            owner: 'first-filter',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            operation: async () => {
                events.push('start first');
                return firstOperation.promise;
            },
        });
        const secondRun = runCoordinatedPdfPageOperation({
            owner: 'second-filter',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            operation: async () => {
                events.push('start second');
                return secondOperation.promise;
            },
        });

        await flushAsync();
        expect(events).toEqual(['start first']);

        firstOperation.resolve('first');
        expect(await firstRun).toBe('first');
        await flushAsync();
        expect(events).toEqual([
            'start first',
            'start second',
        ]);

        secondOperation.resolve('second');
        expect(await secondRun).toBe('second');
    });

    it('preempts a synchronously queued lower-priority render but waits for settlement', async () => {
        const page = cast<PDFPageProxy>({ pageNumber: 1 });
        const events: string[] = [];
        const thumbnailTask = createRenderTask({ settleOnCancel: false });
        const viewerTask = createRenderTask();

        const thumbnailRun = runCoordinatedPdfPageRender({
            owner: 'thumbnail',
            pageNumber: 1,
            pdfPage: page,
            priority: 10,
            startRender: () => {
                events.push('start thumbnail');
                return thumbnailTask;
            },
        });
        const viewerRun = runCoordinatedPdfPageRender({
            owner: 'viewer',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            startRender: () => {
                events.push('start viewer');
                return viewerTask;
            },
        });

        await flushAsync();
        expect(thumbnailTask.cancel).toHaveBeenCalledOnce();
        expect(events).toEqual(['start thumbnail']);

        thumbnailTask.resolve();
        await thumbnailRun;
        await flushAsync();
        expect(events).toEqual([
            'start thumbnail',
            'start viewer',
        ]);

        viewerTask.resolve();
        await viewerRun;
    });

    it('allows synchronous renders for different page proxies to overlap', async () => {
        const firstPage = cast<PDFPageProxy>({ pageNumber: 1 });
        const secondPage = cast<PDFPageProxy>({ pageNumber: 1 });
        const events: string[] = [];
        const firstTask = createRenderTask();
        const secondTask = createRenderTask();

        const firstRun = runCoordinatedPdfPageRender({
            owner: 'first',
            pageNumber: 1,
            pdfPage: firstPage,
            priority: 100,
            startRender: () => {
                events.push('start first');
                return firstTask;
            },
        });
        const secondRun = runCoordinatedPdfPageRender({
            owner: 'second',
            pageNumber: 1,
            pdfPage: secondPage,
            priority: 100,
            startRender: () => {
                events.push('start second');
                return secondTask;
            },
        });

        await flushAsync();
        expect(events).toEqual([
            'start first',
            'start second',
        ]);

        firstTask.resolve();
        secondTask.resolve();
        await Promise.all([
            firstRun,
            secondRun,
        ]);
    });

    it('releases same-page ownership when shouldStart rejects a render', async () => {
        const page = cast<PDFPageProxy>({ pageNumber: 1 });
        const rejectedStart = vi.fn(() => createRenderTask());

        await expect(runCoordinatedPdfPageRender({
            owner: 'stale-viewer',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            shouldStart: () => false,
            startRender: rejectedStart,
        })).rejects.toMatchObject({ name: 'RenderingCancelledException' });
        expect(rejectedStart).not.toHaveBeenCalled();

        const nextTask = createRenderTask();
        const nextStart = vi.fn(() => nextTask);
        const nextRun = runCoordinatedPdfPageRender({
            owner: 'current-viewer',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            startRender: nextStart,
        });

        await flushAsync();
        expect(nextStart).toHaveBeenCalledOnce();

        nextTask.resolve();
        await nextRun;
    });

    it('preempts a lower-priority thumbnail render when the viewer needs the same page', async () => {
        const page = cast<PDFPageProxy>({ pageNumber: 1 });
        const events: string[] = [];
        const thumbnailTask = createRenderTask();
        const viewerTask = createRenderTask();

        const thumbnailRun = runCoordinatedPdfPageRender({
            owner: 'thumbnail',
            pageNumber: 1,
            pdfPage: page,
            priority: 10,
            startRender: () => {
                events.push('start thumbnail');
                return thumbnailTask;
            },
        }).catch(error => error as Error);

        await flushAsync();
        expect(events).toEqual(['start thumbnail']);

        const viewerRun = runCoordinatedPdfPageRender({
            owner: 'viewer',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            startRender: () => {
                events.push('start viewer');
                return viewerTask;
            },
        });

        await flushAsync();
        expect(thumbnailTask.cancel).toHaveBeenCalledOnce();
        expect(events).toEqual([
            'start thumbnail',
            'start viewer',
        ]);

        viewerTask.resolve();
        await viewerRun;
        const thumbnailError = await thumbnailRun;
        expect(thumbnailError).toBeInstanceOf(Error);
        expect((thumbnailError as Error).name).toBe('RenderingCancelledException');
    });

    it('keeps a lower-priority thumbnail render waiting while a viewer render is active', async () => {
        const page = cast<PDFPageProxy>({ pageNumber: 1 });
        const events: string[] = [];
        const viewerTask = createRenderTask();
        const thumbnailTask = createRenderTask();

        const viewerRun = runCoordinatedPdfPageRender({
            owner: 'viewer',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            startRender: () => {
                events.push('start viewer');
                return viewerTask;
            },
        });
        await flushAsync();

        const thumbnailRun = runCoordinatedPdfPageRender({
            owner: 'thumbnail',
            pageNumber: 1,
            pdfPage: page,
            priority: 10,
            startRender: () => {
                events.push('start thumbnail');
                return thumbnailTask;
            },
        });
        await flushAsync();
        expect(events).toEqual(['start viewer']);
        expect(thumbnailTask.cancel).not.toHaveBeenCalled();

        viewerTask.resolve();
        await viewerRun;
        await flushAsync();
        expect(events).toEqual([
            'start viewer',
            'start thumbnail',
        ]);

        thumbnailTask.resolve();
        await thumbnailRun;
    });

    it('aborts a queued render while it waits for the coordinated page turn', async () => {
        const page = cast<PDFPageProxy>({ pageNumber: 1 });
        const events: string[] = [];
        const viewerTask = createRenderTask();
        const queuedTask = createRenderTask();
        const queuedAbortController = new AbortController();

        const viewerRun = runCoordinatedPdfPageRender({
            owner: 'viewer',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            startRender: () => {
                events.push('start viewer');
                return viewerTask;
            },
        });
        await flushAsync();

        const queuedRun = runCoordinatedPdfPageRender({
            owner: 'thumbnail',
            pageNumber: 1,
            pdfPage: page,
            priority: 10,
            signal: queuedAbortController.signal,
            startRender: () => {
                events.push('start queued');
                return queuedTask;
            },
        }).catch(error => error as Error);
        await flushAsync();

        queuedAbortController.abort();

        const queuedError = await queuedRun;
        expect(queuedError).toBeInstanceOf(Error);
        if (!(queuedError instanceof Error)) {
            throw new Error('Expected queued render to reject with an Error');
        }
        expect(queuedError.name).toBe('RenderingCancelledException');
        expect(events).toEqual(['start viewer']);
        expect(queuedTask.cancel).not.toHaveBeenCalled();

        viewerTask.resolve();
        await viewerRun;
    });

    it('lets viewer preparation preempt a lower-priority thumbnail render', async () => {
        const page = cast<PDFPageProxy>({ pageNumber: 1 });
        const events: string[] = [];
        const thumbnailTask = createRenderTask();

        const thumbnailRun = runCoordinatedPdfPageRender({
            owner: 'thumbnail',
            pageNumber: 1,
            pdfPage: page,
            priority: 10,
            startRender: () => {
                events.push('start thumbnail');
                return thumbnailTask;
            },
        }).catch(error => error as Error);
        await flushAsync();

        const operationRun = runCoordinatedPdfPageOperation({
            owner: 'viewer-filter',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            operation: async () => {
                events.push('run viewer filter');
                return 'ok';
            },
        });
        await flushAsync();

        expect(thumbnailTask.cancel).toHaveBeenCalledOnce();
        expect(await operationRun).toBe('ok');
        expect(events).toEqual([
            'start thumbnail',
            'run viewer filter',
        ]);
        const thumbnailError = await thumbnailRun;
        expect(thumbnailError).toBeInstanceOf(Error);
        expect((thumbnailError as Error).name).toBe('RenderingCancelledException');
    });

    it('keeps coordinated operation ownership after abort until the operation settles', async () => {
        const page = cast<PDFPageProxy>({ pageNumber: 1 });
        const events: string[] = [];
        const operation = createDeferred<string>();
        const operationAbortController = new AbortController();
        const viewerTask = createRenderTask();

        const operationRun = runCoordinatedPdfPageOperation({
            owner: 'viewer-filter',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            signal: operationAbortController.signal,
            operation: async () => {
                events.push('start filter');
                return operation.promise;
            },
        }).catch(error => error as Error);
        await flushAsync();
        expect(events).toEqual(['start filter']);

        operationAbortController.abort();
        const operationError = await operationRun;
        if (!(operationError instanceof Error)) {
            throw new Error('Expected operation abort to reject');
        }
        expect(operationError.name).toBe('RenderingCancelledException');

        const renderRun = runCoordinatedPdfPageRender({
            owner: 'viewer',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            startRender: () => {
                events.push('start viewer');
                return viewerTask;
            },
        });
        await flushAsync();

        expect(events).toEqual(['start filter']);

        operation.resolve('late');
        await flushAsync();
        expect(events).toEqual([
            'start filter',
            'start viewer',
        ]);
        viewerTask.resolve();
        await renderRun;
        await flushAsync();
    });

    it('exposes the exact operation settlement independently of its aborted caller', async () => {
        const page = cast<PDFPageProxy>({pageNumber: 1});
        const operation = createDeferred<string>();
        const controller = new AbortController();
        const capturedSettlements: Array<Promise<void>> = [];
        const settled = vi.fn();

        const operationRun = runCoordinatedPdfPageOperation({
            owner: 'captured-filter',
            pageNumber: 1,
            pdfPage: page,
            priority: 100,
            signal: controller.signal,
            captureSettlement: settlement => capturedSettlements.push(settlement),
            operation: () => operation.promise,
        }).catch(error => error as Error);
        await flushAsync();

        expect(capturedSettlements).toHaveLength(1);
        void capturedSettlements[0]!.then(settled);
        controller.abort();
        const operationError = await operationRun;
        expect(operationError).toBeInstanceOf(Error);
        expect((operationError as Error).name).toBe('RenderingCancelledException');
        await flushAsync();
        expect(settled).not.toHaveBeenCalled();

        operation.resolve('late');
        await capturedSettlements[0];
        expect(settled).toHaveBeenCalledOnce();
    });
});
