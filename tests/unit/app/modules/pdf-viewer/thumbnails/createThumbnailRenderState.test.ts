import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createThumbnailRenderState,
    type IThumbnailRenderTask,
} from '@app/modules/pdf-viewer/thumbnails/createThumbnailRenderState';

interface ITestCanvas { name: string; }

function createState() {
    return createThumbnailRenderState<ITestCanvas>();
}

function createCanvas(name: string): ITestCanvas {
    return {name};
}

function createRenderTask(cancel = vi.fn()) {
    return {
        cancel,
        task: {cancel} satisfies IThumbnailRenderTask,
    };
}

describe('createThumbnailRenderState', () => {
    it('tracks rendering and rendered canvases by page, canvas, and render key', () => {
        const state = createState();
        const canvas = createCanvas('current');
        const otherCanvas = createCanvas('other');

        state.beginRender({
            page: 2,
            canvas,
            renderKey: 'key-a',
        });

        expect(state.isRenderingCanvasKey({
            page: 2,
            canvas,
            renderKey: 'key-a',
        })).toBe(true);
        expect(state.isRenderingCanvasKey({
            page: 2,
            canvas,
            renderKey: 'key-b',
        })).toBe(false);
        expect(state.isRenderingCanvasKey({
            page: 2,
            canvas: otherCanvas,
            renderKey: 'key-a',
        })).toBe(false);

        expect(state.markRendered({
            page: 2,
            canvas,
        })).toBe(1);
        expect(state.isRenderedCanvas(2, canvas)).toBe(true);
        expect(state.isRenderedCanvas(2, otherCanvas)).toBe(false);
        expect(state.createSnapshot()).toMatchObject({
            renderedCount: 1,
            renderedPages: [2],
            renderingCount: 1,
            renderingPages: [2],
        });
    });

    it('cancels one page by aborting controllers, cancelling tasks, and clearing rendering identity', () => {
        const state = createState();
        const canvas = createCanvas('page-one');
        const abortController = new AbortController();
        const renderTask = createRenderTask();

        state.beginRender({
            page: 1,
            canvas,
            renderKey: 'key-a',
        });
        state.trackAbortController(1, abortController);
        state.trackRenderTask(1, renderTask.task);

        state.cancelPage(1);

        expect(abortController.signal.aborted).toBe(true);
        expect(renderTask.cancel).toHaveBeenCalledTimes(1);
        expect(state.isRenderingCanvasKey({
            page: 1,
            canvas,
            renderKey: 'key-a',
        })).toBe(false);
        expect(state.createSnapshot().activeTasks).toEqual([]);
    });

    it('cancels all tracked pages and tolerates PDF.js cancellation errors', () => {
        const state = createState();
        const firstAbortController = new AbortController();
        const secondAbortController = new AbortController();
        const firstTask = createRenderTask();
        const secondTask = createRenderTask(vi.fn(() => {
            throw new Error('cancel failed');
        }));

        state.beginRender({
            page: 1,
            canvas: createCanvas('one'),
            renderKey: 'one',
        });
        state.beginRender({
            page: 2,
            canvas: createCanvas('two'),
            renderKey: 'two',
        });
        state.trackAbortController(1, firstAbortController);
        state.trackAbortController(2, secondAbortController);
        state.trackRenderTask(1, firstTask.task);
        state.trackRenderTask(2, secondTask.task);

        expect(() => state.cancelAll()).not.toThrow();
        expect(firstAbortController.signal.aborted).toBe(true);
        expect(secondAbortController.signal.aborted).toBe(true);
        expect(firstTask.cancel).toHaveBeenCalledTimes(1);
        expect(secondTask.cancel).toHaveBeenCalledTimes(1);
        expect(state.createSnapshot()).toMatchObject({
            activeTasks: [],
            renderingCount: 0,
            renderingPages: [],
        });
    });

    it('prunes detached rendered canvases and cancels detached rendering canvases', () => {
        const state = createState();
        const mountedRenderedCanvas = createCanvas('rendered-mounted');
        const detachedRenderedCanvas = createCanvas('rendered-detached');
        const detachedRenderingCanvas = createCanvas('rendering-detached');
        const replacementCanvas = createCanvas('replacement');
        const abortController = new AbortController();
        const renderTask = createRenderTask();

        state.markRendered({
            page: 1,
            canvas: mountedRenderedCanvas,
        });
        state.markRendered({
            page: 2,
            canvas: detachedRenderedCanvas,
        });
        state.beginRender({
            page: 3,
            canvas: detachedRenderingCanvas,
            renderKey: 'rendering',
        });
        state.trackAbortController(3, abortController);
        state.trackRenderTask(3, renderTask.task);

        state.pruneDetached({
            mountedPages: new Set([
                1,
                3,
            ]),
            resolveCanvas: page => {
                if (page === 1) {
                    return mountedRenderedCanvas;
                }
                if (page === 3) {
                    return replacementCanvas;
                }
                return null;
            },
        });

        expect(state.isRenderedCanvas(1, mountedRenderedCanvas)).toBe(true);
        expect(state.isRenderedCanvas(2, detachedRenderedCanvas)).toBe(false);
        expect(state.isRenderingCanvasKey({
            page: 3,
            canvas: detachedRenderingCanvas,
            renderKey: 'rendering',
        })).toBe(false);
        expect(abortController.signal.aborted).toBe(true);
        expect(renderTask.cancel).toHaveBeenCalledTimes(1);
    });

    it('clears finished rendering state only when the canvas and render key still match', () => {
        const state = createState();
        const staleCanvas = createCanvas('stale');
        const currentCanvas = createCanvas('current');

        state.beginRender({
            page: 4,
            canvas: staleCanvas,
            renderKey: 'old',
        });
        state.beginRender({
            page: 4,
            canvas: currentCanvas,
            renderKey: 'new',
        });

        expect(state.clearFinishedRender({
            page: 4,
            canvas: staleCanvas,
            renderKey: 'old',
        })).toBe(false);
        expect(state.isRenderingCanvasKey({
            page: 4,
            canvas: currentCanvas,
            renderKey: 'new',
        })).toBe(true);
        expect(state.clearFinishedRender({
            page: 4,
            canvas: currentCanvas,
            renderKey: 'new',
        })).toBe(true);
        expect(state.hasRenderingPage(4)).toBe(false);
    });

    it('clears render tasks by identity so stale failures cannot remove newer work', () => {
        const state = createState();
        const staleTask = createRenderTask();
        const currentTask = createRenderTask();

        state.trackRenderTask(8, staleTask.task);
        state.trackRenderTask(8, currentTask.task);

        expect(state.clearRenderTask(8, staleTask.task)).toBe(false);
        expect(state.createSnapshot().activeTasks).toEqual([8]);
        expect(state.clearRenderTask(8, currentTask.task)).toBe(true);
        expect(state.createSnapshot().activeTasks).toEqual([]);
    });

    it('owns page render epochs used by thumbnail render keys', () => {
        const state = createState();

        expect(state.getPageRenderEpoch(12)).toBe(0);
        expect(state.bumpPageRenderEpoch(12)).toBe(1);
        expect(state.bumpPageRenderEpoch(12)).toBe(2);
        state.clearPageRenderEpochs();
        expect(state.getPageRenderEpoch(12)).toBe(0);
    });
});
