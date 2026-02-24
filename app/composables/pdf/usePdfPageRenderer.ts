import { Mutex } from 'es-toolkit';
import type {
    AnnotationEditorUIManager,
    PDFPageProxy,
} from 'pdfjs-dist';
import type { IL10n } from 'pdfjs-dist/types/web/interfaces';
import {
    nextTick,
    toValue,
    watch,
    type MaybeRefOrGetter,
    type Ref,
} from 'vue';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdf';
import { chunk } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import type { usePdfDocument } from '@app/composables/pdf/usePdfDocument';
import { usePdfCanvasRenderer } from '@app/composables/pdf/usePdfCanvasRenderer';
import { usePdfTextLayerRenderer } from '@app/composables/pdf/usePdfTextLayerRenderer';
import { usePdfAnnotationLayerRenderer } from '@app/composables/pdf/usePdfAnnotationLayerRenderer';
import { CONCURRENT_RENDERS } from '@app/constants/pdf-layout';
import {
    isRenderingCancelledError,
    captureScrollSnapshot,
    restoreScrollFromSnapshot,
    formatRenderError,
} from '@app/composables/pdf/pdfPageRenderPipeline';
import {
    getPageContainer,
    setupPagePlaceholderSizes,
    type IPageRange,
} from '@app/composables/pdf/pdfPageBufferManager';
import { BrowserLogger } from '@app/utils/browser-logger';
import {
    guardAsync,
    runGuardedTask,
} from '@app/utils/async-guard';
import { createPdfSearchMatchScroller } from '@app/composables/pdf/pdfSearchMatchScroller';
import { logPdfNav } from '@app/utils/pdf-nav-log';
import { getMostVisiblePageFromDom } from '@app/composables/pdf/pdfScrollVisibility';

export {
    isRenderingCancelledError,
    captureScrollSnapshot,
    restoreScrollFromSnapshot,
    formatRenderError,
} from '@app/composables/pdf/pdfPageRenderPipeline';
export {
    getPageContainer,
    setupPagePlaceholderSizes,
    computeVisibleRange,
    type IPageRange,
} from '@app/composables/pdf/pdfPageBufferManager';

interface IUsePdfPageRendererOptions {
    container: Ref<HTMLElement | null>;
    document: ReturnType<typeof usePdfDocument>;
    currentPage: Ref<number>;
    effectiveScale: MaybeRefOrGetter<number>;

    bufferPages?: MaybeRefOrGetter<number>;
    showAnnotations?: MaybeRefOrGetter<boolean>;
    scrollToPage?: (
        pageNumber: number,
        options?: { preferExactDom?: boolean; },
    ) => void;
    suppressSnap?: () => void;
    beginSearchNavigation?: (pageNumber: number) => void;
    endSearchNavigation?: (settleMs?: number) => void;
    outputScale?: number;

    annotationUiManager?: MaybeRefOrGetter<AnnotationEditorUIManager | null>;
    annotationL10n?: MaybeRefOrGetter<IL10n | null>;

    searchPageMatches?: MaybeRefOrGetter<Map<number, IPdfPageMatches>>;
    currentSearchMatch?: MaybeRefOrGetter<IPdfSearchMatch | null>;

    workingCopyPath?: MaybeRefOrGetter<string | null>;
}

export const usePdfPageRenderer = (options: IUsePdfPageRendererOptions) => {
    const {
        pdfDocument,
        numPages,
        basePageWidth,
        basePageHeight,
        isLoading,
        getPage,
        evictPage,
        cleanupPageCache,
    } = options.document;

    const bufferPages = options.bufferPages ?? 2;
    const showAnnotations = options.showAnnotations ?? true;
    const searchPageMatches =
        options.searchPageMatches ?? new Map<number, IPdfPageMatches>();
    const currentSearchMatch = options.currentSearchMatch ?? null;
    const workingCopyPath = options.workingCopyPath ?? null;

    const outputScale =
        options.outputScale ??
    (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

    const canvasRenderer = usePdfCanvasRenderer({ outputScale });
    const textLayerRenderer = usePdfTextLayerRenderer({
        searchPageMatches,
        currentSearchMatch,
        workingCopyPath,
        effectiveScale: options.effectiveScale,
    });
    const annotationLayerRenderer = usePdfAnnotationLayerRenderer({
        numPages,
        currentPage: options.currentPage,
        pdfDocument,
        showAnnotations,
        annotationUiManager: options.annotationUiManager ?? null,
        annotationL10n: options.annotationL10n ?? null,
        scrollToPage: options.scrollToPage,
    });

    const renderMutex = new Mutex();
    let renderVersion = 0;

    const renderedPages = new Set<number>();
    const renderingPages = new Map<number, number>();
    const pageCanvases = new Map<number, HTMLCanvasElement>();
    const textLayerCleanupFns = new Map<number, () => void>();

    const RENDERED_CONTAINER_CLASS = 'page_container--rendered';

    function bumpRenderVersion() {
        renderVersion += 1;
        return renderVersion;
    }

    function logNonCriticalStageError(
        pageNumber: number,
        stage: string,
        error: unknown,
    ) {
        BrowserLogger.error(
            'pdf-renderer',
            `Failed to render ${stage} for page ${pageNumber}`,
            error,
        );
    }

    function scheduleRenderForSinglePage(
        pageNumber: number,
        optionsOverride: {
            preserveRenderedPages?: boolean;
            bufferOverride?: number;
        },
    ) {
        runGuardedTask(
            () =>
                renderVisiblePages(
                    {
                        start: pageNumber,
                        end: pageNumber,
                    },
                    optionsOverride,
                ),
            {
                scope: 'pdf-renderer',
                message: `Failed to schedule follow-up render for page ${pageNumber}`,
            },
        );
    }

    function scheduleRenderOcrDebugBoxes(
        container: HTMLElement,
        pageNumber: number,
        wcPath: string,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        rawPageWidth: number,
        rawPageHeight: number,
    ) {
        guardAsync(
            textLayerRenderer.renderOcrDebugBoxes(
                container,
                pageNumber,
                wcPath,
                viewport,
                rawPageWidth,
                rawPageHeight,
            ),
            {
                scope: 'pdf-renderer',
                message: `Failed to render OCR debug overlays for page ${pageNumber}`,
            },
        );
    }

    const searchMatchScroller = createPdfSearchMatchScroller({
        getContainer: () => options.container.value,
        getCurrentSearchMatch: () => toValue(currentSearchMatch),
        scrollToCurrentMatch,
        scheduleRenderForSinglePage: (pageNumber) => {
            scheduleRenderForSinglePage(pageNumber, {
                preserveRenderedPages: true,
                bufferOverride: 0,
            });
        },
        scrollToPage: options.scrollToPage,
        suppressSnap: options.suppressSnap,
        beginSearchNavigation: options.beginSearchNavigation,
        endSearchNavigation: options.endSearchNavigation,
    });

    function cleanupTextLayer(pageNumber: number) {
        const cleanup = textLayerCleanupFns.get(pageNumber);
        if (cleanup) {
            cleanup();
            textLayerCleanupFns.delete(pageNumber);
        }
    }

    function cleanupPage(pageNumber: number) {
        const containerRoot = options.container.value;

        cleanupTextLayer(pageNumber);

        const canvas = pageCanvases.get(pageNumber);
        if (canvas) {
            canvasRenderer.cleanupCanvas(canvas);
            pageCanvases.delete(pageNumber);
        }

        renderedPages.delete(pageNumber);
        renderingPages.delete(pageNumber);

        annotationLayerRenderer.cleanupEditorLayer(pageNumber);

        if (containerRoot) {
            const container = containerRoot.querySelector<HTMLElement>(
                `.page_container[data-page="${pageNumber}"]`,
            );
            container?.classList.remove(RENDERED_CONTAINER_CLASS);
            const skeleton =
                container?.querySelector<HTMLElement>('.pdf-page-skeleton');
            const canvasHost =
                container?.querySelector<HTMLDivElement>('.page_canvas');
            const textLayerDiv =
                container?.querySelector<HTMLDivElement>('.text-layer');
            const annotationLayerDiv =
                container?.querySelector<HTMLElement>('.annotation-layer');
            const annotationEditorLayerDiv = container?.querySelector<HTMLElement>(
                '.annotation-editor-layer',
            );

            if (canvasHost) {
                canvasHost.innerHTML = '';
            }

            if (skeleton) {
                skeleton.style.display = '';
            }

            if (textLayerDiv) {
                textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
            }

            if (annotationLayerDiv) {
                annotationLayerDiv.innerHTML = '';
            }

            if (annotationEditorLayerDiv) {
                annotationEditorLayerDiv.innerHTML = '';
            }

            if (container) {
                textLayerRenderer.clearOcrDebug(container);
            }
        }

        try {
            evictPage(pageNumber);
        } catch (error) {
            BrowserLogger.error(
                'pdf-renderer',
                'Failed to evict cached PDF page',
                error,
            );
        }
    }

    function setupPagePlaceholders() {
        const containerRoot = options.container.value;
        const baseWidth = toValue(basePageWidth);
        const baseHeight = toValue(basePageHeight);
        if (!containerRoot || !baseWidth || !baseHeight) {
            return;
        }

        const scale = toValue(options.effectiveScale);
        setupPagePlaceholderSizes(containerRoot, baseWidth, baseHeight, scale);
    }

    async function renderVisiblePages(
        visibleRange: IPageRange,
        renderOptions?: {
            preserveRenderedPages?: boolean;
            bufferOverride?: number;
        },
    ) {
        const containerRoot = options.container.value;

        if (!containerRoot || numPages.value === 0) {
            return;
        }

        const version = renderVersion;
        const buffer = renderOptions?.bufferOverride ?? toValue(bufferPages);

        const renderStart = Math.max(1, visibleRange.start - buffer);
        const renderEnd = Math.min(numPages.value, visibleRange.end + buffer);

        const pagesToKeep = new Set(range(renderStart, renderEnd + 1));

        if (!renderOptions?.preserveRenderedPages) {
            for (const pageNum of renderedPages) {
                if (!pagesToKeep.has(pageNum)) {
                    cleanupPage(pageNum);
                }
            }
        }

        const pagesToRenderNow = range(renderStart, renderEnd + 1).filter(
            (i) => !renderedPages.has(i),
        );

        if (pagesToRenderNow.length === 0) {
            return;
        }

        const scale = toValue(options.effectiveScale);

        for (const batch of chunk(pagesToRenderNow, CONCURRENT_RENDERS)) {
            await Promise.all(
                batch.map(async (pageNumber) => {
                    if (renderVersion !== version) {
                        return;
                    }

                    if (renderedPages.has(pageNumber)) {
                        return;
                    }

                    const alreadyRenderingVersion = renderingPages.get(pageNumber);
                    if (alreadyRenderingVersion === version) {
                        return;
                    }

                    renderingPages.set(pageNumber, version);

                    try {
                        const container = getPageContainer(containerRoot, pageNumber - 1);
                        if (!container) {
                            return;
                        }

                        const canvasHost =
                            container.querySelector<HTMLDivElement>('.page_canvas');
                        if (!canvasHost) {
                            return;
                        }

                        const pdfPage = await getPage(pageNumber);
                        if (renderVersion !== version) {
                            return;
                        }

                        const renderResult = await canvasRenderer.renderCanvas(
                            pdfPage,
                            scale,
                        );
                        if (!renderResult) {
                            return;
                        }

                        if (renderVersion !== version) {
                            canvasRenderer.cleanupCanvas(renderResult.canvas);
                            return;
                        }

                        const {
                            canvas,
                            viewport,
                            scaleX,
                            scaleY,
                            rawDims,
                            userUnit,
                            totalScaleFactor,
                        } = renderResult;

                        canvasRenderer.applyContainerDimensions(
                            container,
                            viewport,
                            scale,
                            userUnit,
                            totalScaleFactor,
                        );
                        canvasRenderer.mountCanvas(
                            canvasHost,
                            canvas,
                            container,
                            RENDERED_CONTAINER_CLASS,
                        );
                        pageCanvases.set(pageNumber, canvas);

                        const textLayerDiv =
                            container.querySelector<HTMLDivElement>('.text-layer');
                        if (textLayerDiv) {
                            cleanupTextLayer(pageNumber);
                            let isTextLayerRendered = false;

                            try {
                                await textLayerRenderer.renderTextLayer(
                                    pdfPage,
                                    textLayerDiv,
                                    viewport,
                                    scale,
                                    userUnit,
                                    totalScaleFactor,
                                );
                                isTextLayerRendered = true;
                            } catch (textLayerError) {
                                logNonCriticalStageError(
                                    pageNumber,
                                    'text layer',
                                    textLayerError,
                                );
                                textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
                            }

                            if (renderVersion !== version) {
                                if (renderingPages.get(pageNumber) === version) {
                                    cleanupPage(pageNumber);
                                }
                                return;
                            }

                            if (isTextLayerRendered) {
                                try {
                                    const cleanup =
                                        textLayerRenderer.setupTextLayerInteraction(textLayerDiv);
                                    if (typeof cleanup === 'function') {
                                        textLayerCleanupFns.set(pageNumber, cleanup);
                                    }
                                } catch (textLayerInteractionError) {
                                    logNonCriticalStageError(
                                        pageNumber,
                                        'text layer interaction',
                                        textLayerInteractionError,
                                    );
                                }

                                try {
                                    textLayerRenderer.applyPageSearchHighlights(
                                        container,
                                        textLayerDiv,
                                        pageNumber,
                                        canvas,
                                        {
                                            userUnit,
                                            totalScaleFactor,
                                            viewportWidth: viewport.width,
                                            viewportHeight: viewport.height,
                                            rawPageWidth: rawDims.pageWidth,
                                            rawPageHeight: rawDims.pageHeight,
                                            canvasPixelWidth: canvas.width,
                                            canvasPixelHeight: canvas.height,
                                            renderScaleX: scaleX,
                                            renderScaleY: scaleY,
                                        },
                                    );
                                } catch (searchHighlightError) {
                                    logNonCriticalStageError(
                                        pageNumber,
                                        'search highlights',
                                        searchHighlightError,
                                    );
                                }

                            }
                        }

                        const annotationLayerDiv =
                            container.querySelector<HTMLElement>('.annotation-layer');
                        let annotationLayerInstance = null;
                        if (annotationLayerDiv && toValue(showAnnotations)) {
                            if (renderVersion !== version) {
                                if (renderingPages.get(pageNumber) === version) {
                                    cleanupPage(pageNumber);
                                }
                                return;
                            }

                            try {
                                annotationLayerInstance =
                                    await annotationLayerRenderer.renderAnnotationLayer(
                                        pdfPage,
                                        annotationLayerDiv,
                                        viewport,
                                        pageNumber,
                                    );
                            } catch (annotationError) {
                                logNonCriticalStageError(
                                    pageNumber,
                                    'annotation layer',
                                    annotationError,
                                );
                            }

                            if (renderVersion !== version) {
                                if (renderingPages.get(pageNumber) === version) {
                                    cleanupPage(pageNumber);
                                }
                                return;
                            }
                        }

                        const annotationEditorLayerDiv =
                            container.querySelector<HTMLElement>('.annotation-editor-layer');
                        if (
                            annotationEditorLayerDiv &&
              toValue(options.annotationUiManager)
                        ) {
                            try {
                                annotationLayerRenderer.renderAnnotationEditorLayer(
                                    container,
                                    annotationEditorLayerDiv,
                                    textLayerDiv,
                                    viewport,
                                    pageNumber,
                                    annotationLayerInstance,
                                );
                            } catch (annotationEditorError) {
                                logNonCriticalStageError(
                                    pageNumber,
                                    'annotation editor layer',
                                    annotationEditorError,
                                );
                            }
                        }

                        if (textLayerRenderer.isOcrDebugEnabled()) {
                            const wcPath = toValue(workingCopyPath);
                            if (wcPath) {
                                scheduleRenderOcrDebugBoxes(
                                    container,
                                    pageNumber,
                                    wcPath,
                                    viewport,
                                    rawDims.pageWidth,
                                    rawDims.pageHeight,
                                );
                            }
                        }

                        if (renderVersion === version) {
                            renderedPages.add(pageNumber);
                        }
                    } catch (error) {
                        if (isRenderingCancelledError(error)) {
                            if (renderVersion === version) {
                                setTimeout(() => {
                                    if (renderVersion !== version) {
                                        return;
                                    }
                                    scheduleRenderForSinglePage(pageNumber, {
                                        preserveRenderedPages: true,
                                        bufferOverride: 0,
                                    });
                                }, 0);
                            }
                            return;
                        }

                        BrowserLogger.error(
                            'pdf-renderer',
                            formatRenderError(error, pageNumber),
                        );
                        if (renderingPages.get(pageNumber) === version) {
                            cleanupPage(pageNumber);
                        }
                    } finally {
                        if (renderingPages.get(pageNumber) === version) {
                            renderingPages.delete(pageNumber);
                        }
                    }
                }),
            );
        }
    }

    async function reRenderAllVisiblePages(getVisibleRange: () => IPageRange) {
        const version = bumpRenderVersion();
        const containerAtCapture = options.container.value;
        const snapshot = captureScrollSnapshot(containerAtCapture);
        if (snapshot) {
            BrowserLogger.warn('pdf-nav', `[re-render-snapshot] captured version=${version}`, {
                version,
                currentPage: options.currentPage.value,
                numPages: numPages.value,
                snapshot,
                scrollTop: containerAtCapture ? Math.round(containerAtCapture.scrollTop) : null,
                clientHeight: containerAtCapture ? Math.round(containerAtCapture.clientHeight) : null,
                mostVisiblePage: containerAtCapture
                    ? getMostVisiblePageFromDom(containerAtCapture, numPages.value)
                    : null,
            });
        } else {
            BrowserLogger.warn('pdf-nav', `[re-render-snapshot] missing version=${version}`, {
                version,
                currentPage: options.currentPage.value,
                numPages: numPages.value,
                hasContainer: Boolean(containerAtCapture),
            });
        }

        await renderMutex.acquire();

        try {
            if (renderVersion !== version) {
                return;
            }

            const pagesToCleanup = new Set<number>();
            renderedPages.forEach((page) => pagesToCleanup.add(page));
            renderingPages.forEach((_, page) => pagesToCleanup.add(page));
            pageCanvases.forEach((_, page) => pagesToCleanup.add(page));
            textLayerCleanupFns.forEach((_, page) => pagesToCleanup.add(page));

            pagesToCleanup.forEach((page) => cleanupPage(page));

            setupPagePlaceholders();

            if (renderVersion === version) {
                restoreScrollFromSnapshot(options.container.value, snapshot);
                const containerAfterRestore = options.container.value;
                BrowserLogger.warn('pdf-nav', `[re-render-snapshot] restored version=${version}`, {
                    version,
                    currentPage: options.currentPage.value,
                    numPages: numPages.value,
                    snapshot,
                    scrollTop: containerAfterRestore ? Math.round(containerAfterRestore.scrollTop) : null,
                    clientHeight: containerAfterRestore
                        ? Math.round(containerAfterRestore.clientHeight)
                        : null,
                    mostVisiblePage: containerAfterRestore
                        ? getMostVisiblePageFromDom(containerAfterRestore, numPages.value)
                        : null,
                });
            }

            if (renderVersion !== version) {
                return;
            }

            const visibleRange = getVisibleRange();
            await renderVisiblePages(visibleRange);
        } finally {
            renderMutex.release();
        }
    }

    function cleanupAllPages() {
        bumpRenderVersion();

        const pagesToCleanup = new Set<number>();
        renderedPages.forEach((page) => pagesToCleanup.add(page));
        renderingPages.forEach((_, page) => pagesToCleanup.add(page));
        pageCanvases.forEach((_, page) => pagesToCleanup.add(page));
        textLayerCleanupFns.forEach((_, page) => pagesToCleanup.add(page));

        pagesToCleanup.forEach((page) => cleanupPage(page));

        for (const [
            , canvas,
        ] of pageCanvases) {
            canvasRenderer.cleanupCanvas(canvas);
        }

        pageCanvases.clear();
        renderedPages.clear();
        renderingPages.clear();
        textLayerCleanupFns.clear();
        annotationLayerRenderer.clearAllLayers();

        searchMatchScroller.invalidatePendingRequests();

        try {
            cleanupPageCache();
        } catch (error) {
            BrowserLogger.error(
                'pdf-renderer',
                'Failed to clean up PDF page cache',
                error,
            );
        }
    }

    function applySearchHighlights() {
        const containerRoot = options.container.value;
        if (!containerRoot) {
            return;
        }
        try {
            textLayerRenderer.applyAllSearchHighlights(containerRoot);
        } catch (error) {
            BrowserLogger.error(
                'pdf-renderer',
                'Failed to apply search highlights',
                error,
            );
        }
    }

    function scrollToCurrentMatch() {
        const containerRoot = options.container.value;
        if (!containerRoot) {
            return false;
        }

        let result = false;
        try {
            result = textLayerRenderer.scrollToCurrentMatch(containerRoot);
        } catch (error) {
            BrowserLogger.error(
                'pdf-renderer',
                'Failed to scroll to current match',
                error,
            );
            return false;
        }
        logPdfNav(`[PDF-NAV] scrollToCurrentMatch result=${result}`);
        if (result) {
            options.suppressSnap?.();
        }
        return result;
    }

    watch(
        () => {
            const match = toValue(currentSearchMatch);
            return [
                isLoading.value,
                toValue(searchPageMatches),
                match?.pageIndex ?? -1,
                match?.matchIndex ?? -1,
                match?.startOffset ?? -1,
                match?.endOffset ?? -1,
            ] as const;
        },
        () => {
            if (isLoading.value) {
                return;
            }

            const currentMatchValue = toValue(currentSearchMatch);
            const matchPageIndex = currentMatchValue && numPages.value > 0
                ? Math.max(0, Math.min(currentMatchValue.pageIndex, numPages.value - 1))
                : null;

            logPdfNav(`[PDF-NAV] watcher fired: matchPageIndex=${matchPageIndex}`);

            applySearchHighlights();

            nextTick(() => {
                if (matchPageIndex === null) {
                    return;
                }

                logPdfNav(`[PDF-NAV] watcher nextTick: calling requestScrollToMatch(${matchPageIndex})`);
                searchMatchScroller.requestScrollToMatch(matchPageIndex);
            });
        },
    );

    function invalidatePages(pages: number[]) {
        bumpRenderVersion();
        for (const pageNumber of pages) {
            cleanupPage(pageNumber);
        }
    }

    function requestScrollToCurrentResult() {
        const currentMatchValue = toValue(currentSearchMatch);
        if (!currentMatchValue) {
            return;
        }
        searchMatchScroller.requestScrollToMatch(currentMatchValue.pageIndex);
    }

    return {
        setupPagePlaceholders,
        renderVisiblePages,
        reRenderAllVisiblePages,
        cleanupAllPages,
        invalidatePages,
        applySearchHighlights,
        isPageRendered: (pageNumber: number) => renderedPages.has(pageNumber),
        requestScrollToCurrentResult,
        cancelPendingSearchScroll: searchMatchScroller.invalidatePendingRequests,
    };
};
