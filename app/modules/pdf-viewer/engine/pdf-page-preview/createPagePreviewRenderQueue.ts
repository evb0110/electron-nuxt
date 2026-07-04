import type { PDFPageProxy } from 'pdfjs-dist';
import { BrowserLogger } from '@app/utils/browserLogger';
import { closePagePreviewSource } from '@app/modules/pdf-viewer/engine/pdf-page-preview/createPagePreviewCache';
import type { createPagePreviewCache } from '@app/modules/pdf-viewer/engine/pdf-page-preview/createPagePreviewCache';
import type { TPdfPagePreviewSource } from '@app/modules/pdf-viewer/engine/pdf-page-preview/pdfPagePreviewTypes';
import { runCoordinatedPdfPageRender } from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';

interface ICreatePagePreviewRenderQueueOptions {
    cache: ReturnType<typeof createPagePreviewCache>;
    leasePage: (pageNumber: number) => Promise<PDFPageProxy>;
    releasePage: (pageNumber: number, pdfPage: PDFPageProxy) => void;
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

export const PAGE_PREVIEW_TARGET_PRIORITY = 100;
const MAX_IN_FLIGHT_PREFETCH_RENDERS = 1;
const RENDER_DURATION_SAMPLE_LIMIT = 4;
const PAGE_PREVIEW_RENDER_PRIORITY = 1;

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
    pageNumber: number,
    maxLongestSidePx: number,
    signal: AbortSignal,
) {
    const scale = getRenderScale(pdfPage, maxLongestSidePx);
    const viewport = pdfPage.getViewport({ scale });
    const canvas = createPreviewCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    if (!context) {
        closePagePreviewSource(canvas);
        return null;
    }

    try {
        await runCoordinatedPdfPageRender({
            owner: 'page-preview',
            pageNumber,
            pdfPage,
            priority: PAGE_PREVIEW_RENDER_PRIORITY,
            signal,
            shouldStart: () => !signal.aborted,
            startRender: () => pdfPage.render({
                canvas,
                canvasContext: context,
                viewport,
                annotationMode: 0,
            }),
        });
        if (signal.aborted) {
            closePagePreviewSource(canvas);
            return null;
        }

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

function isAbortError(error: unknown) {
    return error instanceof Error
        && (
            error.name === 'AbortError'
            || error.name === 'RenderingCancelledException'
        );
}

export function createPagePreviewRenderQueue(options: ICreatePagePreviewRenderQueueOptions) {
    const maxLongestSidePx = normalizePositiveInteger(options.maxLongestSidePx, 640);
    const concurrency = normalizePositiveInteger(options.concurrency, 1);
    const queued = new Map<number, IQueuedPreviewRender>();
    const renderDurationSamplesMs: number[] = [];
    const activeAbortControllers = new Set<AbortController>();
    let activeCount = 0;
    let activePrefetchCount = 0;
    let sequence = 0;
    let generation = 0;

    function abortActiveRenders() {
        for (const controller of activeAbortControllers) {
            controller.abort();
        }
        activeAbortControllers.clear();
    }

    function getGeneration() {
        return generation;
    }

    function reset() {
        generation += 1;
        queued.clear();
        abortActiveRenders();
        renderDurationSamplesMs.length = 0;
        options.cache.clear();
    }

    function isPrefetchPriority(priority: number) {
        return priority < PAGE_PREVIEW_TARGET_PRIORITY;
    }

    function getNextQueuedRender() {
        const canStartPrefetch = activePrefetchCount < MAX_IN_FLIGHT_PREFETCH_RENDERS;
        const renders = Array.from(queued.values())
            .filter(render => canStartPrefetch || !isPrefetchPriority(render.priority))
            .sort((left, right) => {
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
            const isPrefetchRender = isPrefetchPriority(nextRender.priority);
            if (isPrefetchRender) {
                activePrefetchCount += 1;
            }
            void runRender(nextRender).finally(() => {
                activeCount -= 1;
                if (isPrefetchRender) {
                    activePrefetchCount -= 1;
                }
                drain();
            });
        }
    }

    function pruneQueuedPrefetches(shouldKeep: (pageNumber: number) => boolean) {
        for (const [
            pageNumber,
            request,
        ] of queued) {
            if (isPrefetchPriority(request.priority) && !shouldKeep(pageNumber)) {
                queued.delete(pageNumber);
            }
        }
    }

    function recordRenderDuration(durationMs: number) {
        renderDurationSamplesMs.push(durationMs);
        if (renderDurationSamplesMs.length > RENDER_DURATION_SAMPLE_LIMIT) {
            renderDurationSamplesMs.shift();
        }
    }

    function getAverageRenderDurationMs() {
        if (renderDurationSamplesMs.length === 0) {
            return null;
        }

        const totalMs = renderDurationSamplesMs.reduce(
            (sum, sample) => sum + sample,
            0,
        );
        return totalMs / renderDurationSamplesMs.length;
    }

    async function runRender(request: IQueuedPreviewRender) {
        if (
            request.generation !== generation
            || options.cache.has(request.pageNumber, generation)
            || options.shouldSkipPage?.(request.pageNumber) === true
        ) {
            return;
        }

        const abortController = new AbortController();
        activeAbortControllers.add(abortController);
        let pdfPage: PDFPageProxy | null = null;
        try {
            pdfPage = await options.leasePage(request.pageNumber);
            if (
                abortController.signal.aborted
                || request.generation !== generation
                || options.cache.has(request.pageNumber, generation)
                || options.shouldSkipPage?.(request.pageNumber) === true
            ) {
                return;
            }

            const renderStartedAtMs = performance.now();
            const preview = await renderPagePreviewSource(
                pdfPage,
                request.pageNumber,
                maxLongestSidePx,
                abortController.signal,
            );
            if (!preview) {
                return;
            }

            if (abortController.signal.aborted || request.generation !== generation) {
                closePagePreviewSource(preview.source);
                return;
            }

            recordRenderDuration(performance.now() - renderStartedAtMs);
            options.cache.set({
                pageNumber: request.pageNumber,
                source: preview.source,
                width: preview.width,
                height: preview.height,
                generation,
            });
            options.onPreviewReady?.(request.pageNumber);
        } catch (error) {
            if (isAbortError(error)) {
                return;
            }
            BrowserLogger.warn(
                'pdf-renderer',
                `Failed to render low-resolution preview for page ${request.pageNumber}`,
                error,
            );
        } finally {
            activeAbortControllers.delete(abortController);
            if (pdfPage) {
                options.releasePage(request.pageNumber, pdfPage);
            }
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
        getAverageRenderDurationMs,
        getGeneration,
        pruneQueuedPrefetches,
        reset,
    };
}
