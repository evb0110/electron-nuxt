import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import type { IPdfjsL10n } from '@app/types/pdfjs';
import type {
    IPageRange,
    IPdfPageMatches,
} from '@app/types/pdfUi';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { usePdfTextLayerRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer';
import { usePdfAnnotationLayerRenderer } from '@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer';
import { usePdfRendererSearchController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererSearchController';
import { createPdfRendererPageDom } from '@app/modules/pdf-viewer/runtime/rendering/pdf-renderer-page-dom/createPdfRendererPageDom';
import { usePdfRendererAnnotationLayerController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererAnnotationLayerController';
import { usePdfRendererTextLayerController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererTextLayerController';
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import { createPdfRenderSupervisor } from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import { PDF_PAGE_RENDER_TIMEOUT_MS } from '@app/constants/timeouts';
import { withPageStageTimeout } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/withPageStageTimeout';
import { resolveHiddenEmbeddedAnnotationIdsForPageContainer } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/syncHiddenEmbeddedAnnotationDom';
import type {
    IPdfLayerRenderResult,
    IPdfPageLayerRenderContext,
    IRenderVisiblePagesOptions,
    IUsePdfPageRendererOptions,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
export type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';

const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

interface IPdfAnnotationProjection {
    readonly annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    readonly annotationL10n: ShallowRef<IPdfjsL10n | null>;
    readonly hiddenAnnotationIds: Readonly<Ref<Set<string>>>;
    readonly canvasHiddenAnnotationIds: Readonly<Ref<Set<string>>>;
    readonly managedAnnotationIds: Readonly<Ref<Set<string>>>;
    replaceAnnotationUiManager(manager: AnnotationEditorUIManager): void;
    pageLayersRendered(pageNumber: number, container: HTMLElement): void;
    pageCommitted(pageNumber: number): void;
}

interface ICommittedPdfPageRaster {
    pageNumber: number;
    version: number;
    requestId: number;
    scale: number;
    container: HTMLElement;
    renderResult: IPdfLayerRenderResult;
    renderOptions: IRenderVisiblePagesOptions;
}

/**
 * Owns only the disposable DOM projections attached after a canvas commit:
 * text, annotation/editor layers, search highlights, and their cleanup.
 * Raster demand, PDF.js RenderTasks, canvas identity, and page state remain
 * authoritative in PdfRenderingSession.
 */
export const usePdfPageRenderer = (options: IUsePdfPageRendererOptions) => {
    const viewport = options.viewport;
    const projection = shallowRef<IPdfAnnotationProjection | null>(null);
    const hiddenAnnotationIds = computed(() => projection.value?.hiddenAnnotationIds.value ?? EMPTY_ID_SET as Set<string>);
    const canvasHiddenAnnotationIds = computed(() => projection.value?.canvasHiddenAnnotationIds.value ?? EMPTY_ID_SET as Set<string>);
    const managedAnnotationIds = computed(() => projection.value?.managedAnnotationIds.value ?? EMPTY_ID_SET as Set<string>);
    const annotationUiManager = computed(() => projection.value?.annotationUiManager.value ?? null);
    const annotationL10n = computed(() => projection.value?.annotationL10n.value ?? null);
    const {
        pdfDocument,
        numPages,
        isLoading,
    } = options.document;
    const showAnnotations = options.showAnnotations ?? true;
    const searchPageMatches =
        options.searchPageMatches ?? new Map<number, IPdfPageMatches>();
    const currentSearchMatch = options.currentSearchMatch ?? null;
    const currentSearchMatchNavigationId = options.currentSearchMatchNavigationId ?? 0;
    const workingCopyPath = options.workingCopyPath ?? null;
    const documentRevisionToken = options.documentRevisionToken ?? null;
    const isActive = options.isActive ?? true;
    const outputScale = options.outputScale
        ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    const renderSupervisor = options.renderSupervisor ?? createPdfRenderSupervisor();
    const textLayerRenderer = usePdfTextLayerRenderer({
        searchPageMatches,
        currentSearchMatch,
        workingCopyPath,
        documentRevisionToken,
        effectiveScale: viewport.scale.effectiveScale,
        viewportWritePort: viewport.viewportWritePort,
    });
    const annotationLayerRenderer = usePdfAnnotationLayerRenderer({
        numPages,
        currentPage: viewport.currentPage,
        pdfDocument,
        showAnnotations,
        hiddenAnnotationIds,
        managedAnnotationIds,
        annotationUiManager,
        annotationL10n,
        renderSupervisor,
        replaceAnnotationUiManager: manager => projection.value?.replaceAnnotationUiManager(manager),
        scrollToPage: pageNumber => {
            viewport.singlePageScroll.scrollToPage(pageNumber);
        },
    });
    const pageRenderState = options.pageRenderState;
    const textLayerCleanupFns = new Map<number, () => void>();
    const activeTextLayerAbortControllers = new Map<number, {
        version: number;
        requestId: number;
        controller: AbortController;
    }>();
    const activeOptionalTextLayerTasks = new Map<number, {
        version: number;
        requestId: number;
        promise: Promise<void>;
    }>();
    function trackOptionalTextLayerTask(
        pageNumber: number,
        version: number,
        requestId: number,
        task: Promise<unknown>,
    ) {
        const promise = task.catch(() => undefined).then(() => undefined).finally(() => {
            const current = activeOptionalTextLayerTasks.get(pageNumber);
            if (current?.version === version && current.requestId === requestId) {
                activeOptionalTextLayerTasks.delete(pageNumber);
            }
        });
        activeOptionalTextLayerTasks.set(pageNumber, {
            version,
            requestId,
            promise,
        });
        return promise;
    }
    function waitForOptionalTextLayerTasksToSettle() {
        return Promise.all(
            Array.from(activeOptionalTextLayerTasks.values(), task => task.promise),
        ).then(() => undefined);
    }
    function cancelActiveTextLayerRender(pageNumber: number) {
        const active = activeTextLayerAbortControllers.get(pageNumber);
        if (!active) {
            return;
        }
        activeTextLayerAbortControllers.delete(pageNumber);
        active.controller.abort();
    }
    function cancelActiveTextLayerRenderIfCurrent(
        pageNumber: number,
        version: number,
        requestId: number,
    ) {
        const active = activeTextLayerAbortControllers.get(pageNumber);
        if (active?.version === version && active.requestId === requestId) {
            cancelActiveTextLayerRender(pageNumber);
        }
    }
    const {
        getMountedPageContainer,
        clearSelectionBeforePageLayerTeardown,
    } = createPdfRendererPageDom({
        container: options.container,
        currentPage: viewport.currentPage,
    });
    const searchController = usePdfRendererSearchController({
        container: options.container,
        isActive,
        isLoading,
        numPages,
        textLayerRenderer,
        searchPageMatches,
        currentSearchMatch,
        currentSearchMatchNavigationId,
        scheduleRenderForSinglePage: pageNumber => runGuardedTask(
            () => options.requestSearchPageRaster(pageNumber),
            {
                category: 'user-visible-operation',
                scope: 'pdf-renderer',
                message: `Failed to schedule search render for page ${String(pageNumber)}`,
            },
        ),
        scrollToPage: (pageNumber, scrollOptions) =>
            viewport.singlePageScroll.scrollToPage(pageNumber, scrollOptions),
        beginSearchNavigation: (pageNumber) => {
            viewport.markUserViewportInteraction();
            viewport.singlePageScroll.beginSearchNavigation(pageNumber);
        },
        revealSearchNavigationTarget: (pageNumber, revealOptions) =>
            viewport.singlePageScroll.revealSearchNavigationTarget(pageNumber, revealOptions),
        endSearchNavigation: () => viewport.singlePageScroll.endSearchNavigation(),
        beginSearchTransaction: (pageNumber, searchOptions) => (
            viewport.transactionController.beginTransaction({
                kind: 'search',
                source: 'search-navigation',
                page: pageNumber,
                anchor: searchOptions?.markerRect ? 'marker' : 'top',
                markerRect: searchOptions?.markerRect ?? null,
            })?.id ?? null
        ),
        isSearchTransactionCurrent: transactionId =>
            viewport.transactionController.isTransactionCurrent(transactionId),
        settleSearchTransaction: transactionId => {
            viewport.transactionController.advanceTransaction(transactionId, 'settled');
        },
        cancelSearchTransaction: transactionId => {
            viewport.transactionController.cancelActiveTransaction({
                reason: 'superseded',
                cancelInFlightRenders: false,
                bumpRenderVersion: false,
                preserveVisualContent: true,
            }, transactionId);
        },
        isPageRenderPending: pageNumber => pageRenderState.getSlot(pageNumber).job === 'rendering',
    });
    watch(viewport.cancelPendingSearchRevision, (revision, previous) => {
        if (revision !== previous) searchController.invalidatePendingRequests();
    }, {flush: 'sync'});
    function cleanupTextLayer(pageNumber: number) {
        textLayerCleanupFns.get(pageNumber)?.();
        textLayerCleanupFns.delete(pageNumber);
    }
    function releasePageLayers(pageNumber: number) {
        const root = options.container.value;
        const container = getMountedPageContainer(pageNumber, root);
        clearPdfSelectionForLayerTeardown({
            target: container,
            root,
            includeDetached: true,
            includeAnyPdfTextSelection: pageNumber === viewport.currentPage.value,
        });
        cancelActiveTextLayerRender(pageNumber);
        cleanupTextLayer(pageNumber);
        annotationLayerRenderer.cleanupEditorLayer(pageNumber);
        const textLayer = container?.querySelector<HTMLDivElement>('.text-layer');
        const annotationLayer = container?.querySelector<HTMLElement>('.annotation-layer');
        const editorLayer = container?.querySelector<HTMLElement>('.annotation-editor-layer');
        if (textLayer) textLayerRenderer.cleanupTextLayerDom(textLayer);
        for (const layer of [
            annotationLayer,
            editorLayer,
        ]) {
            if (!layer) continue;
            zeroCanvasDescendants(layer);
            layer.replaceChildren();
        }
        if (container) {
            delete container.dataset.pageLayerReadiness;
            textLayerRenderer.clearOcrDebug(container);
        }
    }
    function cleanupAllLayers() {
        const pending = waitForOptionalTextLayerTasksToSettle();
        for (const pageNumber of new Set([
            ...textLayerCleanupFns.keys(),
            ...activeTextLayerAbortControllers.keys(),
        ])) {
            releasePageLayers(pageNumber);
        }
        annotationLayerRenderer.clearAllLayers();
        searchController.invalidatePendingRequests();
        return pending;
    }
    function logNonCriticalStageError(
        pageNumber: number,
        stage: string,
        error: unknown,
    ) {
        if (
            error
            && typeof error === 'object'
            && (
                (error as {name?: unknown}).name === 'AbortError'
                || (error as {name?: unknown}).name === 'RenderingCancelledException'
            )
        ) {
            return;
        }
        BrowserLogger.error('pdf-renderer', `Failed to render ${stage} for page ${String(pageNumber)}`, error);
    }
    function cleanupPageIfCurrentRender(pageNumber: number, version: number, requestId?: number) {
        const slot = pageRenderState.getSlot(pageNumber);
        if (
            slot.contentVersion !== version
            || (requestId !== undefined && slot.requestId !== null && slot.requestId !== requestId)
        ) {
            return;
        }
        pageRenderState.failLayerHydration(pageNumber, version, requestId ?? slot.requestId ?? 0);
    }
    const renderAnnotationLayersForPage = usePdfRendererAnnotationLayerController({
        annotationLayerRenderer,
        showAnnotations,
        annotationUiManager,
        getRenderVersion: options.getRenderVersion,
        cleanupPageIfCurrentRender,
        logNonCriticalStageError,
        renderSupervisor,
        onAnnotationLayersRendered: (pageNumber, container) =>
            projection.value?.pageLayersRendered(pageNumber, container),
    });
    const renderTextLayerForPage = usePdfRendererTextLayerController({
        textLayerRenderer,
        activeTextLayerAbortControllers,
        textLayerCleanupFns,
        getRenderVersion: options.getRenderVersion,
        cleanupTextLayer,
        cleanupPageIfCurrentRender,
        cancelActiveTextLayerRender,
        cancelActiveTextLayerRenderIfCurrent,
        clearSelectionBeforePageLayerTeardown,
        logNonCriticalStageError,
    });

    async function hydrateCommittedLayers(
        commit: ICommittedPdfPageRaster,
        priority: 'text-first' | 'annotations-first' = 'annotations-first',
    ) {
        const {
            pageNumber,
            version,
            requestId,
            scale,
            container,
            renderResult,
            renderOptions,
        } = commit;
        if (
            renderOptions.contentIntent === 'canvas-only-buffer'
            || renderOptions.contentIntent === 'canvas-only-refine'
        ) {
            const retainedLayers = renderOptions.contentIntent === 'canvas-only-refine'
                && pageRenderState.getSlot(pageNumber).layerReadiness === 'ready';
            if (!retainedLayers) {
                pageRenderState.markCanvasOnly(pageNumber, version, requestId);
            }
            container.dataset.pageLayerReadiness = retainedLayers ? 'ready' : 'canvas-only';
            pageRenderState.completeRender(pageNumber, version, requestId);
            options.onPageRendered?.(pageNumber);
            options.onRenderedPageStateChanged?.();
            return;
        }
        const lease = await options.document.leasePage(pageNumber);
        const shouldContinue = () => {
            const slot = pageRenderState.getSlot(pageNumber);
            return options.getRenderVersion() === version
                && slot.contentVersion === version
                && slot.container === container
                && container.isConnected !== false
                && container.dataset.page === String(pageNumber)
                && container.contains(renderResult.canvas);
        };
        try {
            if (!shouldContinue()) {
                return;
            }
            pageRenderState.markLayersHydrating(pageNumber, version, requestId);
            container.dataset.pageLayerReadiness = 'hydrating';
            const context: IPdfPageLayerRenderContext = {
                container,
                pdfPage: lease.page,
                renderResult,
                textLayerDiv: container.querySelector<HTMLDivElement>('.text-layer'),
                annotationLayerInstance: null,
                preserveCanvasOnStale: true,
            };
            const renderText = () => renderTextLayerForPage(
                pageNumber,
                version,
                requestId,
                context,
                scale,
                shouldContinue,
            );
            if (priority === 'text-first' && !(await renderText())) {
                return;
            }
            const annotation = await renderAnnotationLayersForPage(
                pageNumber,
                version,
                requestId,
                context,
                shouldContinue,
            );
            if (!annotation.shouldContinue || !shouldContinue()) {
                return;
            }
            context.annotationLayerInstance = annotation.annotationLayerInstance;
            textLayerRenderer.scheduleOcrDebugForPage?.(pageNumber, context);
            if (!pageRenderState.completeRender(pageNumber, version, requestId)) {
                return;
            }
            options.onPageRendered?.(pageNumber);
            options.onRenderedPageStateChanged?.();
            if (priority === 'text-first') {
                if (pageRenderState.markLayersReady(pageNumber, version, container)) {
                    container.dataset.pageLayerReadiness = 'ready';
                }
                return;
            }
            const task = renderText().then((didRender) => {
                if (
                    didRender
                    && pageRenderState.markLayersReady(pageNumber, version, container)
                ) {
                    container.dataset.pageLayerReadiness = 'ready';
                    options.onRenderedPageStateChanged?.();
                }
            });
            await trackOptionalTextLayerTask(pageNumber, version, requestId, task);
        } finally {
            lease.release();
        }
    }

    function renderCommittedPageLayers(commit: ICommittedPdfPageRaster) {
        projection.value?.pageCommitted(commit.pageNumber);
        return hydrateCommittedLayers(
            commit,
            commit.renderOptions.prioritizeTextLayer === true ? 'text-first' : 'annotations-first',
        );
    }

    let layerPromotionGeneration = 0;
    let layerRequestId = 0;
    async function renderLayerPromotions(
        range: IPageRange,
        renderOptions: IRenderVisiblePagesOptions,
    ) {
        const generation = ++layerPromotionGeneration;
        const version = options.getRenderVersion();
        const pages = (renderOptions.rasterDemandPages
            ?? Array.from(
                {length: range.end - range.start + 1},
                (_, index) => range.start + index,
            ))
            .filter(pageNumber => pageNumber >= 1 && pageNumber <= numPages.value);
        for (const pageNumber of pages) {
            if (generation !== layerPromotionGeneration || version !== options.getRenderVersion()) {
                return;
            }
            const slot = pageRenderState.getSlot(pageNumber);
            const container = getMountedPageContainer(pageNumber, options.container.value);
            const canvas = options.getCommittedCanvas(pageNumber);
            if (
                !container
                || !canvas
                || slot.canvasReadiness !== 'ready'
                || slot.contentVersion !== version
            ) {
                continue;
            }
            const requestId = ++layerRequestId;
            if (!pageRenderState.beginLayerHydration(
                pageNumber,
                version,
                requestId,
                options.getRenderDocumentToken(),
                toValue(viewport.scale.effectiveScale),
                toValue(outputScale),
                container,
            )) {
                continue;
            }
            const lease = await options.document.leasePage(pageNumber);
            const pageViewport = lease.page.getViewport({scale: toValue(viewport.scale.effectiveScale)});
            const userUnit = pageViewport.userUnit ?? 1;
            try {
                await hydrateCommittedLayers({
                    pageNumber,
                    version,
                    requestId,
                    scale: toValue(viewport.scale.effectiveScale),
                    container,
                    renderResult: {
                        canvas,
                        viewport: pageViewport,
                        annotationCanvasMap: null,
                        scaleX: canvas.width / pageViewport.width,
                        scaleY: canvas.height / pageViewport.height,
                        rawDims: pageViewport.rawDims as {
                            pageWidth: number;
                            pageHeight: number
                        },
                        userUnit,
                        totalScaleFactor: toValue(viewport.scale.effectiveScale) * userUnit,
                    },
                    renderOptions,
                }, renderOptions.prioritizeTextLayer === true ? 'text-first' : 'annotations-first');
            } finally {
                lease.release();
            }
        }
    }

    async function renderAnnotationEditorLayerForPage(pageNumber: number) {
        if (!toValue(isActive)) {
            return false;
        }
        const container = getMountedPageContainer(pageNumber, options.container.value);
        const manager = annotationUiManager.value;
        if (!container || !manager) {
            return false;
        }
        const editorLayer = container.querySelector<HTMLElement>('.annotation-editor-layer');
        if (!editorLayer) {
            return false;
        }
        const version = options.getRenderVersion();
        const lease = await options.document.leasePage(pageNumber);
        const controller = new AbortController();
        const shouldContinue = () => (
            options.getRenderVersion() === version
            && toValue(isActive)
            && container.isConnected !== false
            && container.dataset.page === String(pageNumber)
        );
        try {
            const pageViewport = lease.page.getViewport({scale: toValue(viewport.scale.effectiveScale)});
            const result = await withPageStageTimeout(
                annotationLayerRenderer.renderAnnotationEditorLayer(
                    container,
                    editorLayer,
                    container.querySelector<HTMLDivElement>('.text-layer'),
                    pageViewport,
                    pageNumber,
                    null,
                    {
                        signal: controller.signal,
                        shouldContinue,
                    },
                ),
                {
                    pageNumber,
                    stage: 'annotation-editor-layer',
                    timeoutMs: PDF_PAGE_RENDER_TIMEOUT_MS,
                },
                shouldContinue,
                () => controller.abort(),
                undefined,
                renderSupervisor,
                controller.signal,
            );
            return result.ok && result.rendered && shouldContinue();
        } catch (error) {
            logNonCriticalStageError(pageNumber, 'annotation editor layer', error);
            return false;
        } finally {
            lease.release();
        }
    }

    function resolveLayerPromotionDemand(pages: readonly number[]) {
        const promotionPages = pages.filter(
            page => pageRenderState.getSlot(page).layerReadiness !== 'ready',
        );
        if (promotionPages.length === 0) {
            return null;
        }
        const range = {
            start: Math.min(...promotionPages),
            end: Math.max(...promotionPages),
        };
        return {
            range,
            options: {
                bufferOverride: 0,
                contentIntent: 'layers-only-promotion' as const,
                preserveInFlightRequiredPages: true,
                preserveRenderedPages: true,
                rasterDemandPages: promotionPages,
                renderWindowOverride: range,
            },
        };
    }

    return {
        renderCommittedPageLayers,
        renderLayerPromotions,
        resolveLayerPromotionDemand,
        cleanupAllLayers,
        releasePageLayers,
        applySearchHighlights: searchController.applySearchHighlights,
        hideManagedAnnotationEditors: (pageNumber?: number) => {
            annotationLayerRenderer.hideHiddenManagedEditors(pageNumber);
        },
        requestScrollToCurrentResult: searchController.requestScrollToCurrentResult,
        cancelPendingSearchScroll: searchController.invalidatePendingRequests,
        renderAnnotationEditorLayerForPage,
        resolveCanvasHiddenAnnotationIds(pageNumber: number, container: HTMLElement | null) {
            const hidden = canvasHiddenAnnotationIds.value;
            return hidden.size === 0 ? hidden : resolveHiddenEmbeddedAnnotationIdsForPageContainer({
                hiddenAnnotationIds: hidden,
                managedAnnotationIds: managedAnnotationIds.value,
                pageContainer: container,
            });
        },
        attachAnnotationProjection(attached: IPdfAnnotationProjection) {
            projection.value = attached;
            return () => {
                if (projection.value === attached) projection.value = null;
            };
        },
    };
};

function zeroCanvasDescendants(root: HTMLElement) {
    for (const canvas of root.querySelectorAll<HTMLCanvasElement>('canvas')) {
        canvas.width = 0;
        canvas.height = 0;
    }
}
