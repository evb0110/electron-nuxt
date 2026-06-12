import type { PDFPageProxy } from 'pdfjs-dist';
import { BrowserLogger } from '@app/utils/browserLogger';
import { closePagePreviewSource } from '@app/modules/pdf-viewer/engine/pdf-page-preview/createPagePreviewCache';
import type { createPagePreviewCache } from '@app/modules/pdf-viewer/engine/pdf-page-preview/createPagePreviewCache';
import type { TPdfPagePreviewSource } from '@app/modules/pdf-viewer/engine/pdf-page-preview/pdfPagePreviewTypes';

interface ICreatePagePreviewRenderQueueOptions {
    cache: ReturnType<typeof createPagePreviewCache>;
    getPage: (pageNumber: number) => Promise<PDFPageProxy>;
    maxLongestSidePx: number;
    concurrency: number;
    shouldSkipPage?: ((pageNumber: number) => boolean) | undefined;
    onPreviewReady?: ((pageNumber: number) => void) | undefined;
}

interface IQueuedPreviewRender {
    pageNumber: number;
    priority: number;
    generation: number;
    sequence: number;
}

function normalizePositiveInteger(value: number, fallback: number) {
    return Number.isFinite(value) && value > 0
        ? Math.max(1, Math.trunc(value))
        : fallback;
}

function getRenderScale(pdfPage: PDFPageProxy, maxLongestSidePx: number) {
    const baseViewport = pdfPage.getViewport({ scale: 1 });
    const longestSide = Math.max(baseViewport.width, baseViewport.height);
    if (!Number.isFinite(longestSide) || longestSide <= 0) {
        return 1;
    }
    return Math.min(1, maxLongestSidePx / longestSide);
}

function createPreviewCanvas(width: number, height: number) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
}

async function createPreviewSourceFromCanvas(canvas: HTMLCanvasElement): Promise<TPdfPagePreviewSource> {
    if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(canvas);
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
        return bitmap;
    }

    return canvas;
}

async function renderPagePreviewSource(
    pdfPage: PDFPageProxy,
    maxLongestSidePx: number,
) {
    const scale = getRenderScale(pdfPage, maxLongestSidePx);
    const viewport = pdfPage.getViewport({ scale });
    const canvas = createPreviewCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    if (!context) {
        closePagePreviewSource(canvas);
        return null;
    }

    const renderTask = pdfPage.render({
        canvas,
        canvasContext: context,
        viewport,
        annotationMode: 0,
    });
    try {
        await renderTask.promise;
        const source = await createPreviewSourceFromCanvas(canvas);
        return {
            source,
            width: source.width,
            height: source.height,
        };
    } catch (error) {
        closePagePreviewSource(canvas);
        throw error;
    }
}

export function createPagePreviewRenderQueue(options: ICreatePagePreviewRenderQueueOptions) {
    const maxLongestSidePx = normalizePositiveInteger(options.maxLongestSidePx, 640);
    const concurrency = normalizePositiveInteger(options.concurrency, 1);
    const queued = new Map<number, IQueuedPreviewRender>();
    let activeCount = 0;
    let sequence = 0;
    let generation = 0;

    function getGeneration() {
        return generation;
    }

    function reset() {
        generation += 1;
        queued.clear();
        options.cache.clear();
    }

    function getNextQueuedRender() {
        const renders = Array.from(queued.values()).sort((left, right) => {
            if (right.priority !== left.priority) {
                return right.priority - left.priority;
            }
            return left.sequence - right.sequence;
        });
        return renders[0] ?? null;
    }

    function drain() {
        while (activeCount < concurrency) {
            const nextRender = getNextQueuedRender();
            if (!nextRender) {
                return;
            }

            queued.delete(nextRender.pageNumber);
            activeCount += 1;
            void runRender(nextRender).finally(() => {
                activeCount -= 1;
                drain();
            });
        }
    }

    async function runRender(request: IQueuedPreviewRender) {
        if (
            request.generation !== generation
            || options.cache.has(request.pageNumber, generation)
            || options.shouldSkipPage?.(request.pageNumber) === true
        ) {
            return;
        }

        try {
            const pdfPage = await options.getPage(request.pageNumber);
            if (
                request.generation !== generation
                || options.cache.has(request.pageNumber, generation)
                || options.shouldSkipPage?.(request.pageNumber) === true
            ) {
                return;
            }

            const preview = await renderPagePreviewSource(pdfPage, maxLongestSidePx);
            if (!preview) {
                return;
            }

            if (request.generation !== generation) {
                closePagePreviewSource(preview.source);
                return;
            }

            options.cache.set({
                pageNumber: request.pageNumber,
                source: preview.source,
                width: preview.width,
                height: preview.height,
                generation,
            });
            options.onPreviewReady?.(request.pageNumber);
        } catch (error) {
            BrowserLogger.warn(
                'pdf-renderer',
                `Failed to render low-resolution preview for page ${request.pageNumber}`,
                error,
            );
        }
    }

    function ensurePage(pageNumber: number, priority = 0) {
        if (
            !Number.isFinite(pageNumber)
            || pageNumber < 1
            || options.cache.has(pageNumber, generation)
            || options.shouldSkipPage?.(pageNumber) === true
        ) {
            return;
        }

        const normalizedPage = Math.trunc(pageNumber);
        const existing = queued.get(normalizedPage);
        if (existing) {
            existing.priority = Math.max(existing.priority, priority);
            return;
        }

        sequence += 1;
        queued.set(normalizedPage, {
            pageNumber: normalizedPage,
            priority,
            generation,
            sequence,
        });
        drain();
    }

    function ensurePages(requests: Array<{
        pageNumber: number;
        priority: number;
    }>) {
        for (const request of requests) {
            ensurePage(request.pageNumber, request.priority);
        }
    }

    return {
        ensurePage,
        ensurePages,
        getGeneration,
        reset,
    };
}
