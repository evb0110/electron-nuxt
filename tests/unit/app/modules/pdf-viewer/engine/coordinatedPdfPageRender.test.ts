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

function flushAsync() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function createCancelledRenderError() {
    const error = new Error('Rendering cancelled');
    error.name = 'RenderingCancelledException';
    return error;
}

function createRenderTask() {
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
            if (!settled) {
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
});
