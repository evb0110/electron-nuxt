export interface IThumbnailRenderTask { cancel: () => void; }

interface IThumbnailRenderIdentity<TCanvas extends object = HTMLCanvasElement> {
    canvas: TCanvas;
    page: number;
    renderKey: string;
}

interface IThumbnailRenderedIdentity<TCanvas extends object = HTMLCanvasElement> {
    canvas: TCanvas;
    page: number;
}

interface IPruneDetachedThumbnailRenderStateOptions<TCanvas extends object = HTMLCanvasElement> {
    mountedPages: ReadonlySet<number>;
    resolveCanvas: (page: number) => TCanvas | null;
}

interface IThumbnailRenderStateSnapshot {
    activeTasks: number[];
    renderedCount: number;
    renderedPages: number[];
    renderingCount: number;
    renderingPages: number[];
}

function cancelRenderTask(task: IThumbnailRenderTask) {
    try {
        task.cancel();
    } catch {
        return;
    }
}

export function createThumbnailRenderState<TCanvas extends object = HTMLCanvasElement>() {
    const renderingPages = new Set<number>();
    const renderTasks = new Map<number, IThumbnailRenderTask>();
    const renderAbortControllers = new Map<number, AbortController>();
    const renderedCanvases = new Map<number, TCanvas>();
    const renderingCanvases = new Map<number, TCanvas>();
    const renderingCanvasKeys = new Map<number, string>();
    const pageRenderEpochs = new Map<number, number>();

    const clearRenderingPage = (page: number) => {
        renderingPages.delete(page);
        renderingCanvases.delete(page);
        renderingCanvasKeys.delete(page);
    };

    const cancelPage = (page: number) => {
        renderAbortControllers.get(page)?.abort();
        renderAbortControllers.delete(page);

        const task = renderTasks.get(page);
        if (task) {
            cancelRenderTask(task);
            renderTasks.delete(page);
        }

        clearRenderingPage(page);
    };

    return {
        get renderedCount() {
            return renderedCanvases.size;
        },
        get renderingCount() {
            return renderingPages.size;
        },
        beginRender(identity: IThumbnailRenderIdentity<TCanvas>) {
            renderingPages.add(identity.page);
            renderingCanvases.set(identity.page, identity.canvas);
            renderingCanvasKeys.set(identity.page, identity.renderKey);
        },
        bumpPageRenderEpoch(page: number) {
            const nextEpoch = (pageRenderEpochs.get(page) ?? 0) + 1;
            pageRenderEpochs.set(page, nextEpoch);
            return nextEpoch;
        },
        cancelAll() {
            for (const abortController of renderAbortControllers.values()) {
                abortController.abort();
            }
            renderAbortControllers.clear();

            for (const task of renderTasks.values()) {
                cancelRenderTask(task);
            }
            renderTasks.clear();
            renderingPages.clear();
            renderingCanvases.clear();
            renderingCanvasKeys.clear();
        },
        cancelPage,
        clearAbortController(page: number, abortController: AbortController) {
            if (renderAbortControllers.get(page) === abortController) {
                renderAbortControllers.delete(page);
            }
        },
        clearAllState() {
            renderedCanvases.clear();
            renderingPages.clear();
            renderingCanvases.clear();
            renderingCanvasKeys.clear();
            renderTasks.clear();
            renderAbortControllers.clear();
        },
        clearFinishedRender(identity: IThumbnailRenderIdentity<TCanvas>) {
            if (
                renderingCanvases.get(identity.page) !== identity.canvas
                || renderingCanvasKeys.get(identity.page) !== identity.renderKey
            ) {
                return false;
            }

            clearRenderingPage(identity.page);
            return true;
        },
        clearPageRenderEpochs() {
            pageRenderEpochs.clear();
        },
        clearRenderTask(page: number, task?: IThumbnailRenderTask) {
            if (task && renderTasks.get(page) !== task) {
                return false;
            }

            return renderTasks.delete(page);
        },
        clearRenderingPage,
        createSnapshot(): IThumbnailRenderStateSnapshot {
            return {
                activeTasks: Array.from(renderTasks.keys()),
                renderedCount: renderedCanvases.size,
                renderedPages: Array.from(renderedCanvases.keys()),
                renderingCount: renderingPages.size,
                renderingPages: Array.from(renderingPages),
            };
        },
        deleteRenderedPage(page: number) {
            return renderedCanvases.delete(page);
        },
        getPageRenderEpoch(page: number) {
            return pageRenderEpochs.get(page) ?? 0;
        },
        hasRenderingPage(page: number) {
            return renderingPages.has(page);
        },
        isRenderedCanvas(page: number, canvas: TCanvas) {
            return renderedCanvases.get(page) === canvas;
        },
        isRenderingCanvasKey(identity: IThumbnailRenderIdentity<TCanvas>) {
            return (
                renderingPages.has(identity.page)
                && renderingCanvases.get(identity.page) === identity.canvas
                && renderingCanvasKeys.get(identity.page) === identity.renderKey
            );
        },
        markRendered(identity: IThumbnailRenderedIdentity<TCanvas>) {
            renderedCanvases.set(identity.page, identity.canvas);
            return renderedCanvases.size;
        },
        pruneDetached(options: IPruneDetachedThumbnailRenderStateOptions<TCanvas>) {
            for (const [
                page,
                canvas,
            ] of renderedCanvases.entries()) {
                if (!options.mountedPages.has(page) || options.resolveCanvas(page) !== canvas) {
                    renderedCanvases.delete(page);
                }
            }

            for (const [
                page,
                canvas,
            ] of renderingCanvases.entries()) {
                if (options.mountedPages.has(page) && options.resolveCanvas(page) === canvas) {
                    continue;
                }

                cancelPage(page);
            }
        },
        trackAbortController(page: number, abortController: AbortController) {
            renderAbortControllers.set(page, abortController);
        },
        trackRenderTask(page: number, task: IThumbnailRenderTask) {
            renderTasks.set(page, task);
        },
    };
}
