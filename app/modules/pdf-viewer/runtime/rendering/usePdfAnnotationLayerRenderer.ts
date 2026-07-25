import { AnnotationEditorType } from '@app/services/pdfjs/runtimeLib';
import type {
    AnnotationEditorUIManager,
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
import type { AnnotationLayer as TAnnotationLayer } from 'pdfjs-dist/types/src/display/annotation_layer';
import type { AnnotationEditorLayer as TAnnotationEditorLayer } from 'pdfjs-dist/types/src/display/editor/annotation_editor_layer';
import type { DrawLayer as TDrawLayer } from 'pdfjs-dist/types/src/display/draw_layer';
import type {
    IPdfjsL10n,
    IPdfjsLinkService,
} from '@app/types/pdfjs';
import type {
    MaybeRefOrGetter,
    Ref,
} from 'vue';
import { disconnectHighlightCompositeOverlay } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/disconnectHighlightCompositeOverlay';
import { observeHighlightCompositeOverlay } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/observeHighlightCompositeOverlay';
import { refreshHighlightCompositeOverlay } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/refreshHighlightCompositeOverlay';
import { combinePdfLayerVisualSnapshotReleases } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/combinePdfLayerVisualSnapshotReleases';
import { shouldHideHiddenEmbeddedAnnotation } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/syncHiddenEmbeddedAnnotationDom';
import { hasPdfPageAnnotationVisualContentForSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/hasPdfPageAnnotationVisualContentForSnapshotRelease';
import { hasPdfPageDrawLayerVisualContent } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/hasPdfPageDrawLayerVisualContent';
import { preservePdfLayerVisualSnapshot } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/preservePdfLayerVisualSnapshot';
import { preservePdfPageAnnotationVisualSnapshot } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/preservePdfPageAnnotationVisualSnapshot';
import { schedulePdfLayerVisualSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/schedulePdfLayerVisualSnapshotRelease';
import { tracePdfAnnotationSaveDom } from '@app/modules/pdf-viewer/engine/pdf-annotation-save-trace/tracePdfAnnotationSaveDom';
import { tracePdfAnnotationSaveEvent } from '@app/modules/pdf-viewer/engine/pdf-annotation-save-trace/tracePdfAnnotationSaveEvent';
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import { createPdfAnnotationEditorCompatibilityAdapter } from '@app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade';
import {
    createPdfjsAnnotationLayer,
    createPdfjsDrawLayer,
    createPdfjsEditorLayer,
    getPdfjsEditorCompatibilityRuntime,
    renderPdfjsAnnotationLayer,
} from '@app/services/pdfjs/pdfViewerFacade';
import { getOptionalFunction } from '@app/services/pdfjs/runtime';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getShellCapability } from '@app/utils/getShellCapability';
import { normalizeAllowedExternalUrl } from '@contracts/externalUrl';
import type { IPdfRenderSupervisor } from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import type {
    IAnnotationEditorLayerPageFailure,
    IAnnotationLayerRenderOptions,
    IAnnotationUiManagerWithAnnotationRenderGuards,
    TAnnotationEditorLayerRenderResult,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfAnnotationLayerRendererTypes';
import { createHiddenAnnotationLayerController } from '@app/modules/pdf-viewer/runtime/rendering/createHiddenAnnotationLayerController';
import { createAnnotationEditorLayerFailureTracker } from '@app/modules/pdf-viewer/runtime/rendering/createAnnotationEditorLayerFailureTracker';
export type { TAnnotationEditorLayerRenderResult } from '@app/modules/pdf-viewer/runtime/rendering/pdfAnnotationLayerRendererTypes';

const ANNOTATION_MANAGER_ISOLATION_TIMEOUT_MS = 250;
const hiddenAnnotationGuardQueues = new WeakMap<
    AnnotationEditorUIManager,
    Promise<unknown>
>();
const quarantinedHiddenAnnotationGuards = new WeakSet<AnnotationEditorUIManager>();
// pdf.js parses a page's annotations once per document but re-serializes them,
// and re-extracts their text content, on every `getAnnotations()` call. The page
// proxy is replaced whenever the document is reloaded, so it is the exact
// lifetime of the parsed data.
const parsedPageAnnotations = new WeakMap<
    PDFPageProxy,
    ReturnType<PDFPageProxy['getAnnotations']>
>();

function getParsedPageAnnotations(pdfPage: PDFPageProxy) {
    const cached = parsedPageAnnotations.get(pdfPage);
    if (cached) {
        return cached;
    }

    const pending = pdfPage.getAnnotations().catch((error: unknown) => {
        parsedPageAnnotations.delete(pdfPage);
        throw error;
    });
    parsedPageAnnotations.set(pdfPage, pending);
    return pending;
}

export function didRenderAnnotationEditorLayer(result: TAnnotationEditorLayerRenderResult) {
    return result.ok && result.rendered;
}

export const usePdfAnnotationLayerRenderer = (deps: {
    numPages: Ref<number>;
    currentPage: Ref<number>;
    pdfDocument: Ref<PDFDocumentProxy | null>;
    showAnnotations: MaybeRefOrGetter<boolean>;
    hiddenAnnotationIds?: MaybeRefOrGetter<Set<string>>;
    managedAnnotationIds?: MaybeRefOrGetter<Set<string>>;
    annotationUiManager: MaybeRefOrGetter<AnnotationEditorUIManager | null>;
    annotationL10n: MaybeRefOrGetter<IPdfjsL10n | null>;
    renderSupervisor?: IPdfRenderSupervisor | undefined;
    getDocumentVersion?: (() => number) | undefined;
    replaceAnnotationUiManager?: ((manager: AnnotationEditorUIManager) => void) | undefined;
    scrollToPage?: (pageNumber: number) => void;
}) => {
    const compatibilityAdapter = createPdfAnnotationEditorCompatibilityAdapter({
        failInDev: import.meta.dev,
        runtime: getPdfjsEditorCompatibilityRuntime(),
    });
    const annotationEditorLayers = new Map<number, TAnnotationEditorLayer>();
    const drawLayers = new Map<number, TDrawLayer>();
    const annotationEditorLayerContainers = new Map<number, HTMLElement>();
    const annotationEditorLayerRefreshRafIds = new Map<number, number>();
    const hiddenAnnotationSignatures = new Map<number, string>();
    const managedAnnotationSignatures = new Map<number, string>();
    const annotationEditorLayerFailures = new Map<number, IAnnotationEditorLayerPageFailure>();
    let activeEditorDocument: PDFDocumentProxy | null = deps.pdfDocument.value;
    let activeAnnotationUiManager: AnnotationEditorUIManager | null = getAnnotationUiManager();
    let annotationLayerRenderToken = 0;
    let annotationEditorLayerRenderToken = 0;
    const annotationLayerPageRenderTokens = new Map<number, number>();
    const annotationEditorLayerPageRenderTokens = new Map<number, number>();
    const fallbackL10n: IPdfjsL10n = {
        getLanguage: () => 'en',
        getDirection: () => 'ltr',
        get: (ids, _args, fallback) => {
            if (typeof fallback === 'string') {
                return Promise.resolve(fallback);
            }
            if (Array.isArray(ids) && ids.length > 0 && typeof ids[0] === 'string') {
                return Promise.resolve(ids[0]);
            }
            return Promise.resolve(typeof ids === 'string' ? ids : '');
        },
        translate: () => Promise.resolve(),
        pause: () => {},
        resume: () => {},
    };

    function getAnnotationUiManager() {
        return compatibilityAdapter.wrapUiManager(toValue(deps.annotationUiManager) ?? null);
    }

    const {
        clearAnnotationEditorLayerFailure,
        isAnnotationEditorLayerQuarantined,
        recordAnnotationEditorLayerFailure,
    } = createAnnotationEditorLayerFailureTracker({
        failures: annotationEditorLayerFailures,
        renderSupervisor: deps.renderSupervisor,
        hasDocument: () => Boolean(deps.pdfDocument.value),
    });

    const {
        applyHiddenEditableAnnotationFilter,
        getEditableAnnotationId,
        getHiddenAnnotationSignature,
        getManagedAnnotationSignature,
        getNormalizedHiddenAnnotationIds,
        getNormalizedManagedAnnotationIds,
        hideHiddenManagedEditors,
        isHiddenEditableAnnotationId,
        removeHiddenAnnotations,
    } = createHiddenAnnotationLayerController({
        hiddenAnnotationIds: deps.hiddenAnnotationIds,
        managedAnnotationIds: deps.managedAnnotationIds,
        getAnnotationUiManager,
        annotationEditorLayers,
        drawLayers,
        annotationEditorLayerContainers,
    });

    function isAnnotationEditorCompatibilityUnsupported() {
        return compatibilityAdapter.report.severity === 'unsupported';
    }

    function getAnnotationId(annotation: unknown) {
        if (!annotation || typeof annotation !== 'object') {
            return null;
        }

        const annotationId = (annotation as { id?: unknown }).id;
        return typeof annotationId === 'string' ? annotationId : null;
    }

    async function withHiddenAnnotationRenderGuards(
        annotationUiManager: AnnotationEditorUIManager | null,
        pageContainer: HTMLElement | null,
        render: () => Promise<void>,
        pageNumber: number,
        options?: IAnnotationLayerRenderOptions,
    ) {
        if (!annotationUiManager) {
            await raceWithAnnotationAbort(render(), pageNumber, options);
            return true;
        }
        if (quarantinedHiddenAnnotationGuards.has(annotationUiManager)) {
            return false;
        }

        const previousGuard = hiddenAnnotationGuardQueues.get(annotationUiManager)
            ?? Promise.resolve();
        const guardTurn = previousGuard.catch(() => {
            // Previous guarded renders report their own errors.
        });
        const guardRelease = Promise.withResolvers<undefined>();
        const queueTail = guardTurn.then(() => guardRelease.promise);
        hiddenAnnotationGuardQueues.set(annotationUiManager, queueTail);
        void queueTail.finally(() => {
            if (hiddenAnnotationGuardQueues.get(annotationUiManager) === queueTail) {
                hiddenAnnotationGuardQueues.delete(annotationUiManager);
            }
        });
        let releaseAfterUnderlyingRender = false;
        let managerIsolationTimer: ReturnType<typeof setTimeout> | null = null;
        try {
            await raceWithAnnotationAbort(guardTurn, pageNumber, options);
            if (quarantinedHiddenAnnotationGuards.has(annotationUiManager)) {
                return false;
            }

            const mutableUiManager =
                annotationUiManager as AnnotationEditorUIManager & IAnnotationUiManagerWithAnnotationRenderGuards;
            const originalRenderAnnotationElement = getOptionalFunction<[unknown]>(
                annotationUiManager,
                'renderAnnotationElement',
            );
            const originalSetMissingCanvas = getOptionalFunction<
                [string, string, HTMLCanvasElement]
            >(
                annotationUiManager,
                'setMissingCanvas',
            );

            if (!originalRenderAnnotationElement && !originalSetMissingCanvas) {
                await raceWithAnnotationAbort(render(), pageNumber, options);
                return true;
            }

            let guardedRenderAnnotationElement: IAnnotationUiManagerWithAnnotationRenderGuards['renderAnnotationElement'];
            if (originalRenderAnnotationElement) {
                guardedRenderAnnotationElement = (annotation: unknown) => {
                    if (isHiddenEditableAnnotationId(getEditableAnnotationId(annotation), pageContainer)) {
                        return undefined;
                    }

                    return originalRenderAnnotationElement.call(annotationUiManager, annotation);
                };
                mutableUiManager.renderAnnotationElement = guardedRenderAnnotationElement;
            }

            let guardedSetMissingCanvas: IAnnotationUiManagerWithAnnotationRenderGuards['setMissingCanvas'];
            if (originalSetMissingCanvas) {
                guardedSetMissingCanvas = (
                    annotationId: string,
                    annotationElementId: string,
                    canvas: HTMLCanvasElement,
                ) => {
                    if (isHiddenEditableAnnotationId(annotationId, pageContainer)) {
                        return undefined;
                    }

                    return originalSetMissingCanvas.call(
                        annotationUiManager,
                        annotationId,
                        annotationElementId,
                        canvas,
                    );
                };
                mutableUiManager.setMissingCanvas = guardedSetMissingCanvas;
            }

            const restoreInterceptionGuards = () => {
                if (
                    originalRenderAnnotationElement
                    && mutableUiManager.renderAnnotationElement === guardedRenderAnnotationElement
                ) {
                    mutableUiManager.renderAnnotationElement = originalRenderAnnotationElement;
                }
                if (
                    originalSetMissingCanvas
                    && mutableUiManager.setMissingCanvas === guardedSetMissingCanvas
                ) {
                    mutableUiManager.setMissingCanvas = originalSetMissingCanvas;
                }
            };

            try {
                const underlyingRender = render();
                try {
                    await raceWithAnnotationAbort(underlyingRender, pageNumber, options);
                    return true;
                } catch (error) {
                    if (options?.signal?.aborted) {
                        releaseAfterUnderlyingRender = true;
                        quarantinedHiddenAnnotationGuards.add(annotationUiManager);
                        managerIsolationTimer = setTimeout(() => {
                            managerIsolationTimer = null;
                            if (getAnnotationUiManager() !== annotationUiManager) {
                                return;
                            }
                            try {
                                deps.replaceAnnotationUiManager?.(annotationUiManager);
                            } catch (replacementError) {
                                BrowserLogger.warn(
                                    'pdf-annotation-layer',
                                    'Failed to isolate a stalled annotation UI manager',
                                    replacementError,
                                );
                            }
                        }, ANNOTATION_MANAGER_ISOLATION_TIMEOUT_MS);
                        const settleStaleManager = () => {
                            if (managerIsolationTimer !== null) {
                                clearTimeout(managerIsolationTimer);
                                managerIsolationTimer = null;
                            }
                            quarantinedHiddenAnnotationGuards.delete(annotationUiManager);
                            restoreInterceptionGuards();
                            guardRelease.resolve(undefined);
                        };
                        void underlyingRender.then(settleStaleManager, settleStaleManager);
                    }
                    throw error;
                }
            } finally {
                if (!releaseAfterUnderlyingRender) {
                    restoreInterceptionGuards();
                }
            }
        } finally {
            if (!releaseAfterUnderlyingRender) {
                guardRelease.resolve(undefined);
            }
        }

    }

    function syncEditorLayersWithCurrentDocument(
        pageContainer?: HTMLElement | null,
        annotationEditorLayerDiv?: HTMLElement | null,
    ) {
        const currentDocument = deps.pdfDocument.value;
        const currentUiManager = getAnnotationUiManager();
        if (
            currentDocument === activeEditorDocument
            && currentUiManager === activeAnnotationUiManager
        ) {
            return null;
        }
        tracePdfAnnotationSaveDom(
            'editor-layer:document-ui-manager-changed:before-clear',
            pageContainer ?? null,
            {
                hasCurrentDocument: Boolean(currentDocument),
                hasCurrentUiManager: Boolean(currentUiManager),
            },
        );
        const snapshotRelease = preservePdfPageAnnotationVisualSnapshot(
            pageContainer ?? null,
            annotationEditorLayerDiv ?? null,
        );
        activeEditorDocument = currentDocument;
        activeAnnotationUiManager = currentUiManager;
        annotationEditorLayerFailures.clear();
        clearAllLayers();
        tracePdfAnnotationSaveDom(
            'editor-layer:document-ui-manager-changed:after-clear',
            pageContainer ?? null,
        );
        return snapshotRelease;
    }

    function hideAnnotationEditorLayer(annotationEditorLayerDiv: HTMLElement) {
        annotationEditorLayerDiv.innerHTML = '';
        annotationEditorLayerDiv.hidden = true;
    }

    function detachTimedOutAnnotationEditorLayer(annotationEditorLayerDiv: HTMLElement) {
        const parent = annotationEditorLayerDiv.parentNode;
        if (!parent || typeof annotationEditorLayerDiv.cloneNode !== 'function') {
            return;
        }

        const replacement = annotationEditorLayerDiv.cloneNode(false) as HTMLElement;
        replacement.innerHTML = '';
        replacement.hidden = true;
        parent.replaceChild(replacement, annotationEditorLayerDiv);
    }

    function isDocumentVersionCurrent(options?: IAnnotationLayerRenderOptions) {
        return options?.documentVersion === undefined
            || deps.getDocumentVersion?.() === undefined
            || deps.getDocumentVersion() === options.documentVersion;
    }

    function shouldContinueLayerRender(options?: IAnnotationLayerRenderOptions) {
        return options?.signal?.aborted !== true
            && isDocumentVersionCurrent(options)
            && options?.shouldContinue?.() !== false;
    }

    function createAnnotationLayerCancelledError(pageNumber: number) {
        const error = new Error(`Annotation layer render cancelled for page ${pageNumber}`);
        error.name = 'AbortError';
        return error;
    }

    async function raceWithAnnotationAbort<T>(
        promise: Promise<T>,
        pageNumber: number,
        options?: IAnnotationLayerRenderOptions,
    ) {
        const signal = options?.signal;
        if (!signal) {
            return promise;
        }
        if (signal.aborted) {
            throw createAnnotationLayerCancelledError(pageNumber);
        }

        let removeAbortListener = () => {};
        const abortPromise = new Promise<never>((_resolve, reject) => {
            const abort = () => reject(createAnnotationLayerCancelledError(pageNumber));
            signal.addEventListener('abort', abort, { once: true });
            removeAbortListener = () => signal.removeEventListener('abort', abort);
        });
        try {
            return await Promise.race([
                promise,
                abortPromise,
            ]);
        } finally {
            removeAbortListener();
        }
    }

    function getPageContainerForLayer(layer: HTMLElement) {
        return typeof layer.closest === 'function'
            ? layer.closest<HTMLElement>('.page_container')
            : null;
    }

    async function renderAnnotationLayer(
        pdfPage: PDFPageProxy,
        annotationLayerDiv: HTMLElement,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        pageNumber: number,
        annotationCanvasMap?: Map<string, HTMLCanvasElement> | null,
        options?: IAnnotationLayerRenderOptions,
    ) {
        if (!shouldContinueLayerRender(options)) {
            return null;
        }
        const renderToken = ++annotationLayerRenderToken;
        annotationLayerPageRenderTokens.set(pageNumber, renderToken);
        const pageContainer = getPageContainerForLayer(annotationLayerDiv);
        const annotationLayerSnapshotRelease =
            preservePdfLayerVisualSnapshot(annotationLayerDiv);
        tracePdfAnnotationSaveDom(
            'annotation-layer:get-annotations:start',
            pageContainer,
            {
                pageNumber,
                renderToken,
            },
        );
        try {
            const annotations = await raceWithAnnotationAbort(
                getParsedPageAnnotations(pdfPage),
                pageNumber,
                options,
            );
            tracePdfAnnotationSaveEvent(
                'annotation-layer:get-annotations:resolved',
                {
                    annotations: annotations.length,
                    pageNumber,
                    renderToken,
                },
            );
            if (
                annotationLayerPageRenderTokens.get(pageNumber) !== renderToken
                || !shouldContinueLayerRender(options)
            ) {
                tracePdfAnnotationSaveDom(
                    'annotation-layer:get-annotations:stale-token',
                    pageContainer,
                    {
                        pageNumber,
                        renderToken,
                    },
                );
                return null;
            }
            const hiddenAnnotationIds = getNormalizedHiddenAnnotationIds();
            const managedAnnotationIds = getNormalizedManagedAnnotationIds();
            const visibleAnnotations = hiddenAnnotationIds.size === 0
                ? annotations
                : annotations.filter(annotation => {
                    return !shouldHideHiddenEmbeddedAnnotation({
                        annotationId: getAnnotationId(annotation),
                        hiddenAnnotationIds,
                        managedAnnotationIds,
                        pageContainer,
                    });
                });
            const annotationStorage = deps.pdfDocument.value?.annotationStorage;
            const annotationUiManager = getAnnotationUiManager();

            const simpleLinkService = {
                pagesCount: deps.numPages.value,
                page: deps.currentPage.value,
                rotation: 0,
                isInPresentationMode: false,
                externalLinkEnabled: true,
                goToDestination: async () => {},
                goToPage: (page) => {
                    if (typeof page === 'number') {
                        deps.scrollToPage?.(page);
                    }
                },
                goToXY: () => {},
                addLinkAttributes: (
                    link,
                    url,
                    _newWindow?: boolean,
                ) => {
                    const openLink = () => {
                        const normalizedUrl = normalizeAllowedExternalUrl(url);
                        if (!normalizedUrl) {
                            BrowserLogger.warn('pdf-annotation-layer', `Blocked unsupported annotation link: ${url}`);
                            return;
                        }

                        void getShellCapability().openExternal(normalizedUrl).catch((error) => {
                            BrowserLogger.warn(
                                'pdf-annotation-layer',
                                `Failed to open annotation link: ${normalizedUrl}`,
                                error,
                            );
                        });
                    };

                    link.removeAttribute('href');
                    link.removeAttribute('target');
                    link.removeAttribute('rel');
                    link.setAttribute('role', 'link');
                    link.setAttribute('tabindex', '0');
                    link.dataset.href = url;
                    link.addEventListener('click', (event) => {
                        event.preventDefault();
                        openLink();
                    });
                    link.addEventListener('auxclick', (event) => {
                        event.preventDefault();
                    });
                    link.addEventListener('contextmenu', (event) => {
                        event.preventDefault();
                    });
                    link.addEventListener('keydown', (event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') {
                            return;
                        }
                        event.preventDefault();
                        openLink();
                    });
                },
                getDestinationHash: () => '#',
                getAnchorUrl: () => '#',
                setHash: () => {},
                executeNamedAction: () => {},
                executeSetOCGState: () => {},
            } satisfies IPdfjsLinkService;

            const annotationLayerInstance = createPdfjsAnnotationLayer({
                div: annotationLayerDiv as HTMLDivElement,
                page: pdfPage,
                viewport,
                annotationCanvasMap: annotationCanvasMap ?? null,
                annotationEditorUiManager: annotationUiManager,
                linkService: simpleLinkService,
                annotationStorage,
            });
            if (!shouldContinueLayerRender(options)) {
                annotationLayerDiv.innerHTML = '';
                return null;
            }

            tracePdfAnnotationSaveDom(
                'annotation-layer:render:start',
                pageContainer,
                {
                    annotations: annotations.length,
                    hiddenAnnotations: hiddenAnnotationIds.size,
                    hiddenAnnotationIds: Array.from(hiddenAnnotationIds).slice(0, 30),
                    pageNumber,
                    visibleAnnotations: visibleAnnotations.length,
                },
            );
            const didRenderAnnotationLayer = await withHiddenAnnotationRenderGuards(
                annotationUiManager,
                pageContainer,
                async () => {
                    if (!shouldContinueLayerRender(options)) {
                        return;
                    }
                    await renderPdfjsAnnotationLayer(annotationLayerInstance, {
                        annotations: visibleAnnotations,
                        viewport,
                        div: annotationLayerDiv as HTMLDivElement,
                        page: pdfPage,
                        linkService: simpleLinkService,
                        renderForms: false,
                        annotationStorage,
                    });
                },
                pageNumber,
                options,
            );
            if (!didRenderAnnotationLayer) {
                return null;
            }
            if (
                annotationLayerPageRenderTokens.get(pageNumber) !== renderToken
            ) {
                return null;
            }
            if (!shouldContinueLayerRender(options)) {
                if (annotationLayerPageRenderTokens.get(pageNumber) === renderToken) {
                    annotationLayerDiv.innerHTML = '';
                }
                return null;
            }
            tracePdfAnnotationSaveDom(
                'annotation-layer:render:done',
                pageContainer,
                {
                    pageNumber,
                    visibleAnnotations: visibleAnnotations.length,
                },
            );
            if (visibleAnnotations.length === 0) {
                annotationLayerDiv.innerHTML = '';
                tracePdfAnnotationSaveDom(
                    'annotation-layer:render:cleared-empty',
                    pageContainer,
                    { pageNumber },
                );
            }
            removeHiddenAnnotations(annotationLayerDiv);
            tracePdfAnnotationSaveDom(
                'annotation-layer:render:after-hidden-filter',
                pageContainer,
                { pageNumber },
            );

            return applyHiddenEditableAnnotationFilter(annotationLayerInstance, pageContainer);
        } finally {
            schedulePdfLayerVisualSnapshotRelease(annotationLayerSnapshotRelease, { minFrames: 2 });
        }
    }

    async function renderAnnotationEditorLayer(
        container: HTMLElement,
        annotationEditorLayerDiv: HTMLElement,
        textLayerDiv: HTMLDivElement | null,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        pageNumber: number,
        annotationLayerInstance: TAnnotationLayer | null,
        options?: IAnnotationLayerRenderOptions,
    ) {
        if (!shouldContinueLayerRender(options)) {
            return {
                ok: true,
                rendered: false,
                reason: 'stale',
            } satisfies TAnnotationEditorLayerRenderResult;
        }
        let shouldWaitForDrawLayerVisuals =
            hasPdfPageDrawLayerVisualContent(container);
        let snapshotRelease = syncEditorLayersWithCurrentDocument(
            container,
            annotationEditorLayerDiv,
        );
        const renderToken = ++annotationEditorLayerRenderToken;
        annotationEditorLayerPageRenderTokens.set(pageNumber, renderToken);
        const isCurrentEditorLayerRender = () => (
            annotationEditorLayerPageRenderTokens.get(pageNumber) === renderToken
        );
        let renderUiManager: AnnotationEditorUIManager | null = null;
        let renderEditorLayer: TAnnotationEditorLayer | null = null;
        let renderDrawLayer: TDrawLayer | null = null;
        let editorLayerRender: Promise<TAnnotationEditorLayer> | null = null;
        function cleanupCapturedEditorLayer() {
            if (!renderEditorLayer) {
                return;
            }
            const mappedEditorLayer = annotationEditorLayers.get(pageNumber);
            const ownsCurrentResources = (
                mappedEditorLayer === renderEditorLayer
                && renderUiManager !== null
                && getAnnotationUiManager() === renderUiManager
                && isCurrentEditorLayerRender()
                && renderDrawLayer !== null
                && drawLayers.get(pageNumber) === renderDrawLayer
                && (
                    !annotationEditorLayerContainers.has(pageNumber)
                    || annotationEditorLayerContainers.get(pageNumber) === container
                )
            );
            if (ownsCurrentResources) {
                cleanupEditorLayer(pageNumber);
                return;
            }
            const supersededRenderReusesCapturedLayer = (
                mappedEditorLayer === renderEditorLayer
                && !isCurrentEditorLayerRender()
            );
            if (supersededRenderReusesCapturedLayer) {
                return;
            }
            if (mappedEditorLayer === renderEditorLayer) {
                annotationEditorLayers.delete(pageNumber);
            }
            if (renderEditorLayer.div !== null) {
                try {
                    renderEditorLayer.destroy();
                } catch (destroyError) {
                    BrowserLogger.debug(
                        'pdf-annotation-layer',
                        'Failed to destroy superseded annotation editor layer',
                        destroyError,
                    );
                }
            }
        }
        tracePdfAnnotationSaveDom(
            'editor-layer:render:start',
            container,
            {
                pageNumber,
                renderToken,
            },
        );

        try {
            const annotationUiManager = getAnnotationUiManager();
            renderUiManager = annotationUiManager;
            if (!shouldContinueLayerRender(options)) {
                return {
                    ok: true,
                    rendered: false,
                    reason: 'stale',
                } satisfies TAnnotationEditorLayerRenderResult;
            }
            if (!annotationUiManager) {
                hideAnnotationEditorLayer(annotationEditorLayerDiv);
                tracePdfAnnotationSaveDom(
                    'editor-layer:render:hidden-no-ui-manager',
                    container,
                    { pageNumber },
                );
                return {
                    ok: true,
                    rendered: false,
                    reason: 'no-ui-manager',
                } satisfies TAnnotationEditorLayerRenderResult;
            }
            if (quarantinedHiddenAnnotationGuards.has(annotationUiManager)) {
                tracePdfAnnotationSaveDom(
                    'editor-layer:render:skipped-manager-quarantine',
                    container,
                    { pageNumber },
                );
                return {
                    ok: true,
                    rendered: false,
                    reason: 'quarantined',
                } satisfies TAnnotationEditorLayerRenderResult;
            }
            if (isAnnotationEditorCompatibilityUnsupported()) {
                const error = new Error(compatibilityAdapter.report.failures.join('; '));
                recordAnnotationEditorLayerFailure(
                    pageNumber,
                    'pdfjs-compatibility-unsupported',
                    error,
                );
                cleanupEditorLayer(pageNumber, {
                    preserveRenderToken: true,
                    preserveFailure: true,
                });
                hideAnnotationEditorLayer(annotationEditorLayerDiv);
                return {
                    ok: false,
                    reason: 'pdfjs-compatibility-unsupported',
                    error,
                    retryable: false,
                } satisfies TAnnotationEditorLayerRenderResult;
            }
            if (isAnnotationEditorLayerQuarantined(pageNumber)) {
                hideAnnotationEditorLayer(annotationEditorLayerDiv);
                tracePdfAnnotationSaveDom(
                    'editor-layer:render:quarantined',
                    container,
                    { pageNumber },
                );
                return {
                    ok: true,
                    rendered: false,
                    reason: 'quarantined',
                } satisfies TAnnotationEditorLayerRenderResult;
            }

            const pageMetrics = getAnnotationEditorPageMetrics(viewport);
            const signatures = getAnnotationEditorSignatures(pageNumber);
            if (!shouldContinueLayerRender(options)) {
                return {
                    ok: true,
                    rendered: false,
                    reason: 'stale',
                } satisfies TAnnotationEditorLayerRenderResult;
            }
            if (willReplaceAnnotationEditorLayer(pageNumber, signatures)) {
                tracePdfAnnotationSaveDom(
                    'editor-layer:render:will-replace',
                    container,
                    { pageNumber },
                );
                shouldWaitForDrawLayerVisuals ||= hasPdfPageDrawLayerVisualContent(container);
                snapshotRelease = combinePdfLayerVisualSnapshotReleases([
                    snapshotRelease,
                    preservePdfPageAnnotationVisualSnapshot(
                        container,
                        annotationEditorLayerDiv,
                    ),
                ]);
            }
            const editorLayer = getReusableAnnotationEditorLayer(
                pageNumber,
                signatures,
            );
            const drawLayer = getOrCreateDrawLayer(container, pageNumber);
            renderDrawLayer = drawLayer;

            if (!editorLayer) {
                tracePdfAnnotationSaveDom(
                    'editor-layer:render:create-layer',
                    container,
                    { pageNumber },
                );
                shouldWaitForDrawLayerVisuals ||= hasPdfPageDrawLayerVisualContent(container);
                snapshotRelease = combinePdfLayerVisualSnapshotReleases([
                    snapshotRelease,
                    preservePdfPageAnnotationVisualSnapshot(
                        container,
                        annotationEditorLayerDiv,
                    ),
                ]);
                prepareAnnotationEditorLayerDiv(
                    annotationEditorLayerDiv,
                    annotationUiManager,
                );
            }

            editorLayerRender = renderOrUpdateAnnotationEditorLayer({
                annotationEditorLayerDiv,
                annotationLayerInstance,
                annotationUiManager,
                drawLayer,
                editorLayer,
                pageMetrics,
                pageNumber,
                shouldContinue: () => (
                    isCurrentEditorLayerRender()
                    && shouldContinueLayerRender(options)
                ),
                textLayerDiv,
            });
            renderEditorLayer = editorLayer ?? annotationEditorLayers.get(pageNumber) ?? null;
            const activeLayer = await raceWithAnnotationAbort(
                editorLayerRender,
                pageNumber,
                options,
            );
            const isCapturedRenderIdentityCurrent = (
                isCurrentEditorLayerRender()
                && renderUiManager === annotationUiManager
                && getAnnotationUiManager() === annotationUiManager
                && renderEditorLayer === activeLayer
                && annotationEditorLayers.get(pageNumber) === activeLayer
                && renderDrawLayer === drawLayer
                && drawLayers.get(pageNumber) === drawLayer
                && (
                    !annotationEditorLayerContainers.has(pageNumber)
                    || annotationEditorLayerContainers.get(pageNumber) === container
                )
            );
            if (!isCapturedRenderIdentityCurrent) {
                cleanupCapturedEditorLayer();
                return {
                    ok: true,
                    rendered: false,
                    reason: 'stale',
                } satisfies TAnnotationEditorLayerRenderResult;
            }
            if (!shouldContinueLayerRender(options)) {
                cleanupCapturedEditorLayer();
                return {
                    ok: true,
                    rendered: false,
                    reason: 'stale',
                } satisfies TAnnotationEditorLayerRenderResult;
            }

            applyAnnotationEditorLayerMode(
                annotationEditorLayerDiv,
                annotationUiManager,
                activeLayer,
            );
            tracePdfAnnotationSaveDom(
                'editor-layer:render:done',
                container,
                { pageNumber },
            );
            saveAnnotationEditorSignatures(pageNumber, signatures);
            annotationEditorLayerContainers.set(pageNumber, container);
            hideHiddenManagedEditors(pageNumber);
            observeHighlightCompositeOverlay(container);
            scheduleHighlightCompositeRefresh(container, pageNumber, options?.shouldContinue);
            clearAnnotationEditorLayerFailure(pageNumber);
            return {
                ok: true,
                rendered: true,
            } satisfies TAnnotationEditorLayerRenderResult;
        } catch (error) {
            const isIntentionalCancellation = (
                options?.signal?.aborted === true
                || !isCurrentEditorLayerRender()
                || !shouldContinueLayerRender(options)
                || (error instanceof Error && error.name === 'AbortError')
                || (renderUiManager !== null && getAnnotationUiManager() !== renderUiManager)
            );
            if (isIntentionalCancellation) {
                const ownsCurrentRender = (
                    isCurrentEditorLayerRender()
                    && renderUiManager !== null
                    && getAnnotationUiManager() === renderUiManager
                    && (renderEditorLayer === null || annotationEditorLayers.get(pageNumber) === renderEditorLayer)
                    && (
                        !annotationEditorLayerContainers.has(pageNumber)
                        || annotationEditorLayerContainers.get(pageNumber) === container
                    )
                );
                if (ownsCurrentRender && options?.signal?.aborted) {
                    detachTimedOutAnnotationEditorLayer(annotationEditorLayerDiv);
                    hideAnnotationEditorLayer(annotationEditorLayerDiv);
                }
                if (editorLayerRender) {
                    void editorLayerRender.then(
                        cleanupCapturedEditorLayer,
                        cleanupCapturedEditorLayer,
                    );
                }
                return {
                    ok: true,
                    rendered: false,
                    reason: 'stale',
                } satisfies TAnnotationEditorLayerRenderResult;
            }
            tracePdfAnnotationSaveDom(
                'editor-layer:render:error',
                container,
                {
                    error: error instanceof Error ? error.message : String(error),
                    pageNumber,
                },
            );
            const failure = recordAnnotationEditorLayerFailure(
                pageNumber,
                'render-error',
                error,
            );
            BrowserLogger.warn(
                'pdf-annotation-layer',
                `Annotation editor layer render failed for page ${pageNumber}`,
                {
                    attempts: failure.failure.attempts,
                    retryable: failure.retryable,
                    error,
                },
            );
            if (
                renderUiManager !== null
                && getAnnotationUiManager() === renderUiManager
                && isCurrentEditorLayerRender()
                && (
                    renderEditorLayer === null
                        ? !annotationEditorLayers.has(pageNumber)
                        : annotationEditorLayers.get(pageNumber) === renderEditorLayer
                )
                && renderDrawLayer !== null
                && drawLayers.get(pageNumber) === renderDrawLayer
                && (
                    !annotationEditorLayerContainers.has(pageNumber)
                    || annotationEditorLayerContainers.get(pageNumber) === container
                )
            ) {
                cleanupEditorLayer(pageNumber, {
                    preserveRenderToken: true,
                    preserveFailure: true,
                });
            }
            hideAnnotationEditorLayer(annotationEditorLayerDiv);
            return {
                ok: false,
                reason: 'render-error',
                error,
                retryable: failure.retryable,
            } satisfies TAnnotationEditorLayerRenderResult;
        } finally {
            tracePdfAnnotationSaveDom(
                'editor-layer:render:release-snapshot',
                container,
                {
                    pageNumber,
                    shouldWaitForDrawLayerVisuals,
                },
            );
            if (shouldWaitForDrawLayerVisuals) {
                schedulePdfLayerVisualSnapshotRelease(snapshotRelease, {
                    maxDelayMs: 1200,
                    minFrames: 1,
                    waitFor: () => hasPdfPageAnnotationVisualContentForSnapshotRelease(container),
                });
            } else {
                schedulePdfLayerVisualSnapshotRelease(snapshotRelease);
            }
        }
    }

    function getAnnotationEditorPageMetrics(
        viewport: ReturnType<PDFPageProxy['getViewport']>,
    ) {
        return { editorViewport: viewport.clone({ dontFlip: true }) };
    }

    function getAnnotationEditorSignatures(pageNumber: number) {
        return {
            hidden: getHiddenAnnotationSignature(),
            managed: getManagedAnnotationSignature(),
            previousHidden: hiddenAnnotationSignatures.get(pageNumber) ?? '',
            previousManaged: managedAnnotationSignatures.get(pageNumber) ?? '',
        };
    }

    function getReusableAnnotationEditorLayer(
        pageNumber: number,
        signatures: ReturnType<typeof getAnnotationEditorSignatures>,
    ) {
        const editorLayer = annotationEditorLayers.get(pageNumber);
        if (willReplaceAnnotationEditorLayer(pageNumber, signatures)) {
            cleanupEditorLayer(pageNumber, { preserveRenderToken: true });
            return undefined;
        }

        return editorLayer;
    }

    function willReplaceAnnotationEditorLayer(
        pageNumber: number,
        signatures: ReturnType<typeof getAnnotationEditorSignatures>,
    ) {
        return Boolean(
            annotationEditorLayers.get(pageNumber)
            && (
                signatures.previousHidden !== signatures.hidden
                || signatures.previousManaged !== signatures.managed
            ),
        );
    }

    function getOrCreateDrawLayer(
        container: HTMLElement,
        pageNumber: number,
    ) {
        const drawLayer = drawLayers.get(pageNumber) ?? createPdfjsDrawLayer();
        const canvasHost = container.querySelector<HTMLDivElement>('.page_canvas__render-layer');
        if (canvasHost) {
            drawLayer.setParent(canvasHost);
        }
        drawLayers.set(pageNumber, drawLayer);
        return drawLayer;
    }

    function prepareAnnotationEditorLayerDiv(
        annotationEditorLayerDiv: HTMLElement,
        annotationUiManager: AnnotationEditorUIManager,
    ) {
        annotationEditorLayerDiv.innerHTML = '';
        const direction: unknown = annotationUiManager.direction;
        if (direction === 'ltr' || direction === 'rtl' || direction === 'auto') {
            annotationEditorLayerDiv.dir = direction;
        }
    }

    async function renderOrUpdateAnnotationEditorLayer(params: {
        annotationEditorLayerDiv: HTMLElement;
        annotationLayerInstance: TAnnotationLayer | null;
        annotationUiManager: AnnotationEditorUIManager;
        drawLayer: TDrawLayer;
        editorLayer: TAnnotationEditorLayer | undefined;
        pageMetrics: ReturnType<typeof getAnnotationEditorPageMetrics>;
        pageNumber: number;
        shouldContinue: () => boolean;
        textLayerDiv: HTMLDivElement | null;
    }) {
        const {
            annotationEditorLayerDiv,
            annotationLayerInstance,
            annotationUiManager,
            drawLayer,
            editorLayer,
            pageMetrics,
            pageNumber,
            shouldContinue,
            textLayerDiv,
        } = params;
        const l10n = toValue(deps.annotationL10n) ?? fallbackL10n;
        const textLayerRef = compatibilityAdapter.normalizeTextLayer(textLayerDiv);
        const activeLayer = compatibilityAdapter.wrapEditorLayer(editorLayer ?? createPdfjsEditorLayer({
            uiManager: annotationUiManager,
            div: annotationEditorLayerDiv as HTMLDivElement,
            pageIndex: pageNumber - 1,
            l10n,
            viewport: pageMetrics.editorViewport,
            annotationLayer: annotationLayerInstance ?? undefined,
            textLayer: textLayerRef,
            drawLayer,
        }));

        if (editorLayer) {
            editorLayer.update({ viewport: pageMetrics.editorViewport });
        } else {
            annotationEditorLayers.set(pageNumber, activeLayer);
            await Promise.resolve(activeLayer.render({ viewport: pageMetrics.editorViewport }));
            if (!shouldContinue()) {
                if (annotationEditorLayers.get(pageNumber) === activeLayer) {
                    annotationEditorLayers.delete(pageNumber);
                }
                try {
                    activeLayer.destroy();
                } catch (error) {
                    BrowserLogger.debug(
                        'pdf-annotation-layer',
                        'Failed to destroy a stale annotation editor layer',
                        error,
                    );
                }
                throw createAnnotationLayerCancelledError(pageNumber);
            }
        }

        return activeLayer;
    }

    function cancelHighlightCompositeRefresh(pageNumber: number) {
        const rafId = annotationEditorLayerRefreshRafIds.get(pageNumber);
        if (typeof rafId !== 'number' || typeof window === 'undefined') {
            annotationEditorLayerRefreshRafIds.delete(pageNumber);
            return;
        }
        window.cancelAnimationFrame(rafId);
        annotationEditorLayerRefreshRafIds.delete(pageNumber);
    }

    function scheduleHighlightCompositeRefresh(
        container: HTMLElement,
        pageNumber: number,
        shouldContinue?: () => boolean,
    ) {
        cancelHighlightCompositeRefresh(pageNumber);
        const isCurrentContainer = () => (
            shouldContinue?.() !== false
            && container.isConnected !== false
            && annotationEditorLayerContainers.get(pageNumber) === container
        );
        if (typeof window === 'undefined') {
            if (isCurrentContainer()) {
                refreshHighlightCompositeOverlay(container);
            }
            return;
        }
        const rafId = window.requestAnimationFrame(() => {
            if (annotationEditorLayerRefreshRafIds.get(pageNumber) !== rafId) {
                return;
            }
            annotationEditorLayerRefreshRafIds.delete(pageNumber);
            if (!isCurrentContainer()) {
                return;
            }
            refreshHighlightCompositeOverlay(container);
        });
        annotationEditorLayerRefreshRafIds.set(pageNumber, rafId);
    }

    function applyAnnotationEditorLayerMode(
        annotationEditorLayerDiv: HTMLElement,
        annotationUiManager: AnnotationEditorUIManager,
        activeLayer: TAnnotationEditorLayer,
    ) {
        const currentMode =
            typeof annotationUiManager.getMode === 'function'
                ? annotationUiManager.getMode()
                : AnnotationEditorType.NONE;
        const shouldHideLayer =
            currentMode === AnnotationEditorType.NONE && activeLayer.isInvisible;

        annotationEditorLayerDiv.hidden = shouldHideLayer;
        activeLayer.pause(shouldHideLayer);
    }

    function saveAnnotationEditorSignatures(
        pageNumber: number,
        signatures: ReturnType<typeof getAnnotationEditorSignatures>,
    ) {
        hiddenAnnotationSignatures.set(pageNumber, signatures.hidden);
        managedAnnotationSignatures.set(pageNumber, signatures.managed);
    }

    function cleanupEditorLayer(
        pageNumber: number,
        options?: {
            preserveFailure?: boolean;
            preserveRenderToken?: boolean;
        },
    ) {
        cancelHighlightCompositeRefresh(pageNumber);
        if (options?.preserveRenderToken !== true) {
            annotationEditorLayerPageRenderTokens.delete(pageNumber);
        }
        if (options?.preserveFailure !== true) {
            clearAnnotationEditorLayerFailure(pageNumber);
        }
        hiddenAnnotationSignatures.delete(pageNumber);
        managedAnnotationSignatures.delete(pageNumber);
        const container = annotationEditorLayerContainers.get(pageNumber);
        clearPdfSelectionForLayerTeardown({
            target: container ?? null,
            includeDetached: true,
            includeAnyPdfTextSelection: pageNumber === deps.currentPage.value,
        });
        if (container) {
            disconnectHighlightCompositeOverlay(container);
            annotationEditorLayerContainers.delete(pageNumber);
        }
        const editorLayer = annotationEditorLayers.get(pageNumber);
        if (editorLayer) {
            try {
                editorLayer.destroy();
            } catch (error) {
                BrowserLogger.debug(
                    'pdf-annotation-layer',
                    'Failed to destroy annotation editor layer',
                    error,
                );
            }
            annotationEditorLayers.delete(pageNumber);
        }

        const drawLayer = drawLayers.get(pageNumber);
        if (drawLayer) {
            try {
                drawLayer.destroy();
            } catch (error) {
                BrowserLogger.debug(
                    'pdf-annotation-layer',
                    'Failed to destroy draw layer',
                    error,
                );
            } finally {
                drawLayers.delete(pageNumber);
            }
        }
    }

    function clearAllLayers() {
        annotationLayerPageRenderTokens.clear();
        annotationEditorLayerPageRenderTokens.clear();
        annotationEditorLayerFailures.clear();
        for (const pageNumber of [...annotationEditorLayerRefreshRafIds.keys()]) {
            cancelHighlightCompositeRefresh(pageNumber);
        }
        for (const pageNumber of [...annotationEditorLayers.keys()]) {
            cleanupEditorLayer(pageNumber);
        }
        for (const [
            pageNumber,
            drawLayer,
        ] of drawLayers) {
            try {
                drawLayer.destroy();
            } catch (error) {
                BrowserLogger.debug(
                    'pdf-annotation-layer',
                    `Failed to destroy draw layer for page ${pageNumber}`,
                    error,
                );
            }
        }
        drawLayers.clear();
        for (const container of annotationEditorLayerContainers.values()) {
            disconnectHighlightCompositeOverlay(container);
        }
        annotationEditorLayerContainers.clear();
    }

    return {
        renderAnnotationLayer,
        renderAnnotationEditorLayer,
        hideHiddenManagedEditors,
        cleanupEditorLayer,
        clearAllLayers,
    };
};
