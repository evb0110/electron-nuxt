import {
    AnnotationLayer,
    AnnotationEditorLayer,
    AnnotationEditorType,
    DrawLayer,
} from '@app/services/pdfjs/runtimeLib';
import type {
    PDFPageProxy,
    AnnotationEditorUIManager,
    PDFDocumentProxy,
} from 'pdfjs-dist';
import type { AnnotationLayer as TAnnotationLayer } from 'pdfjs-dist/types/src/display/annotation_layer';
import type { AnnotationEditorLayer as TAnnotationEditorLayer } from 'pdfjs-dist/types/src/display/editor/annotation_editor_layer';
import type { DrawLayer as TDrawLayer } from 'pdfjs-dist/types/src/display/draw_layer';
import type {
    IL10n,
    IPDFLinkService,
} from 'pdfjs-dist/types/web/interfaces';
import type {
    MaybeRefOrGetter,
    Ref,
} from 'vue';
import { uniq } from 'es-toolkit/array';
import { defaultDocument } from '@vueuse/core';
import { normalizePdfJsAnnotationId } from '@app/composables/pdf/pdfSerializationRefs';
import {
    disconnectHighlightCompositeOverlay,
    observeHighlightCompositeOverlay,
    refreshHighlightCompositeOverlay,
} from '@app/composables/pdf/pdfHighlightCompositeOverlay';
import { getOptionalFunction } from '@app/services/pdfjs/runtime';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getShellCapability } from '@app/utils/platformShell';
import { normalizeAllowedExternalUrl } from '@contracts/externalUrl';

interface IAnnotationEditorLayerProto {
    disable?: (...args: unknown[]) => unknown;
    destroy?: (...args: unknown[]) => unknown;
    __evbSafetyPatchApplied?: boolean;
}

interface IAnnotationUiManagerWithAnnotationRenderGuards {
    renderAnnotationElement?: (annotation: unknown) => unknown;
    setMissingCanvas?: (
        annotationId: string,
        annotationElementId: string,
        canvas: HTMLCanvasElement,
    ) => unknown;
    getEditors?: (pageIndex: number) => Iterable<unknown>;
    getActive?: () => unknown;
    setActiveEditor?: (editor: unknown | null) => unknown;
}

interface IPdfjsTextLayerElement extends HTMLDivElement {div: HTMLDivElement;}
interface IEditableAnnotationDataLike {id?: string | null;}
interface IEditableAnnotationLike {data?: IEditableAnnotationDataLike | null;}
interface IAnnotationLayerWithEditableAnnotations {
    getEditableAnnotations?: () => unknown[];
    getEditableAnnotation?: (id: string) => unknown;
}

let annotationEditorLayerSafetyPatched = false;
let destroyedEditorLayerFallbackDiv: HTMLDivElement | null = null;

function getDestroyedEditorLayerFallbackDiv() {
    if (destroyedEditorLayerFallbackDiv) {
        return destroyedEditorLayerFallbackDiv;
    }

    const doc = defaultDocument;
    if (!doc) {
        return null;
    }

    const fallbackDiv = doc.createElement('div');
    fallbackDiv.className = 'annotation-editor-layer-destroyed-fallback';
    fallbackDiv.style.display = 'none';
    fallbackDiv.setAttribute('aria-hidden', 'true');
    destroyedEditorLayerFallbackDiv = fallbackDiv;
    return fallbackDiv;
}

function ensureAnnotationEditorLayerSafetyPatch() {
    if (annotationEditorLayerSafetyPatched) {
        return;
    }

    const proto = AnnotationEditorLayer.prototype as IAnnotationEditorLayerProto;
    if (!proto || proto.__evbSafetyPatchApplied) {
        annotationEditorLayerSafetyPatched = true;
        return;
    }

    getDestroyedEditorLayerFallbackDiv();

    const originalDisable =
        typeof proto.disable === 'function' ? proto.disable : null;
    if (originalDisable) {
        proto.disable = function patchedDisable(
            this: { div?: HTMLElement | null },
            ...args: unknown[]
        ) {
            if (!this) {
                return undefined;
            }
            const fallbackDiv = getDestroyedEditorLayerFallbackDiv();
            if (!this.div && fallbackDiv) {
                this.div = fallbackDiv;
            }
            return originalDisable.call(this, ...args);
        };
    }

    const originalDestroy =
        typeof proto.destroy === 'function' ? proto.destroy : null;
    if (originalDestroy) {
        proto.destroy = function patchedDestroy(
            this: { div?: HTMLElement | null },
            ...args: unknown[]
        ) {
            const fallbackDiv = getDestroyedEditorLayerFallbackDiv();
            if (this?.div == null && fallbackDiv) {
                this.div = fallbackDiv;
            }
            const result = originalDestroy.call(this, ...args);
            if (this?.div == null && fallbackDiv) {
                this.div = fallbackDiv;
            }
            return result;
        };
    }

    proto.__evbSafetyPatchApplied = true;
    annotationEditorLayerSafetyPatched = true;
}

export const usePdfAnnotationLayerRenderer = (deps: {
    numPages: Ref<number>;
    currentPage: Ref<number>;
    pdfDocument: Ref<PDFDocumentProxy | null>;
    showAnnotations: MaybeRefOrGetter<boolean>;
    hiddenAnnotationIds?: MaybeRefOrGetter<Set<string>>;
    managedAnnotationIds?: MaybeRefOrGetter<Set<string>>;
    annotationUiManager: MaybeRefOrGetter<AnnotationEditorUIManager | null>;
    annotationL10n: MaybeRefOrGetter<IL10n | null>;
    scrollToPage?: (pageNumber: number) => void;
}) => {
    ensureAnnotationEditorLayerSafetyPatch();

    const annotationEditorLayers = new Map<number, TAnnotationEditorLayer>();
    const drawLayers = new Map<number, TDrawLayer>();
    const annotationEditorLayerContainers = new Map<number, HTMLElement>();
    const hiddenAnnotationSignatures = new Map<number, string>();
    const managedAnnotationSignatures = new Map<number, string>();
    const annotationEditorLayerDisabledDocuments =
        new WeakSet<PDFDocumentProxy>();
    let annotationEditorLayerDisabledWithoutDocument = false;
    let activeEditorDocument: PDFDocumentProxy | null = deps.pdfDocument.value;
    const fallbackL10n: IL10n = {
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

    function getNormalizedHiddenAnnotationIds() {
        const normalizedIds = new Set<string>();
        (toValue(deps.hiddenAnnotationIds) ?? new Set<string>()).forEach((id) => {
            const normalizedId = normalizePdfJsAnnotationId(id);
            if (normalizedId) {
                normalizedIds.add(normalizedId);
            }
        });
        return normalizedIds;
    }

    function getNormalizedManagedAnnotationIds() {
        const normalizedIds = new Set<string>();
        (toValue(deps.managedAnnotationIds) ?? new Set<string>()).forEach((id) => {
            const normalizedId = normalizePdfJsAnnotationId(id);
            if (normalizedId) {
                normalizedIds.add(normalizedId);
            }
        });
        return normalizedIds;
    }

    function getAnnotationId(annotation: unknown) {
        if (!annotation || typeof annotation !== 'object') {
            return null;
        }

        const annotationId = (annotation as { id?: unknown }).id;
        return typeof annotationId === 'string' ? annotationId : null;
    }

    function getHiddenAnnotationSignature() {
        return [...getNormalizedHiddenAnnotationIds()]
            .sort((left, right) => left.localeCompare(right))
            .join('\u0000');
    }

    function getManagedAnnotationSignature() {
        return [...getNormalizedManagedAnnotationIds()]
            .sort((left, right) => left.localeCompare(right))
            .join('\u0000');
    }

    function getEditableAnnotationId(editable: unknown) {
        if (!editable || typeof editable !== 'object') {
            return null;
        }

        const data = (editable as IEditableAnnotationLike).data;
        return typeof data?.id === 'string'
            ? data.id
            : null;
    }

    function isHiddenEditableAnnotationId(annotationId: string | null | undefined) {
        const normalizedId = normalizePdfJsAnnotationId(annotationId);
        return Boolean(
            normalizedId
            && getNormalizedHiddenAnnotationIds().has(normalizedId),
        );
    }

    function getEditorAnnotationElementId(editor: unknown) {
        if (!editor || typeof editor !== 'object') {
            return null;
        }

        const annotationElementId = (editor as { annotationElementId?: unknown }).annotationElementId;
        return typeof annotationElementId === 'string'
            ? annotationElementId
            : null;
    }

    function getEditorPageIndex(editor: unknown) {
        if (!editor || typeof editor !== 'object') {
            return null;
        }

        const pageIndex = (editor as { pageIndex?: unknown }).pageIndex;
        return typeof pageIndex === 'number' && Number.isFinite(pageIndex)
            ? pageIndex
            : null;
    }

    function hideHiddenManagedEditors(pageNumber?: number) {
        const annotationUiManager = toValue(deps.annotationUiManager) ?? null;
        if (!annotationUiManager) {
            return;
        }

        const getEditors = getOptionalFunction<[number], Iterable<unknown>>(
            annotationUiManager,
            'getEditors',
        );
        if (!getEditors) {
            return;
        }

        const targetPageNumbers = pageNumber
            ? [pageNumber]
            : uniq([
                ...annotationEditorLayers.keys(),
                ...drawLayers.keys(),
            ]).sort((left, right) => left - right);
        if (targetPageNumbers.length === 0) {
            return;
        }

        const getActive = getOptionalFunction<[], unknown>(annotationUiManager, 'getActive');
        const setActiveEditor = getOptionalFunction<[unknown | null], unknown>(
            annotationUiManager,
            'setActiveEditor',
        );
        const activeEditor = getActive?.call(annotationUiManager) ?? null;

        targetPageNumbers.forEach((targetPageNumber) => {
            const editors = Array.from(getEditors.call(annotationUiManager, targetPageNumber - 1) ?? []);
            editors.forEach((editor) => {
                const annotationId = normalizePdfJsAnnotationId(getEditorAnnotationElementId(editor));
                if (!annotationId || !isHiddenEditableAnnotationId(annotationId)) {
                    return;
                }

                const show = getOptionalFunction<[boolean?], unknown>(editor, 'show');
                show?.call(editor, false);

                const disableEditing = getOptionalFunction<[], unknown>(editor, 'disableEditing');
                disableEditing?.call(editor);

                const parent = (
                    editor
                    && typeof editor === 'object'
                    && 'parent' in editor
                )
                    ? (editor as { parent?: unknown }).parent
                    : null;
                const getEditableAnnotation = getOptionalFunction<[string], unknown>(
                    parent,
                    'getEditableAnnotation',
                );
                const editable = getEditableAnnotation?.call(parent, annotationId) ?? null;
                const hideEditable = getOptionalFunction<[], unknown>(editable, 'hide');
                hideEditable?.call(editable);

                const editorPageIndex = getEditorPageIndex(editor);
                if (
                    activeEditor === editor
                    && editorPageIndex !== null
                    && (editorPageIndex + 1) === targetPageNumber
                ) {
                    setActiveEditor?.call(annotationUiManager, null);
                }
            });
        });
    }

    async function withHiddenAnnotationRenderGuards<T>(
        annotationUiManager: AnnotationEditorUIManager | null,
        render: () => Promise<T>,
    ) {
        if (!annotationUiManager) {
            return render();
        }

        const mutableUiManager =
            annotationUiManager as AnnotationEditorUIManager & IAnnotationUiManagerWithAnnotationRenderGuards;
        const originalRenderAnnotationElement = getOptionalFunction<[unknown], unknown>(
            annotationUiManager,
            'renderAnnotationElement',
        );
        const originalSetMissingCanvas = getOptionalFunction<
            [string, string, HTMLCanvasElement],
            unknown
        >(
            annotationUiManager,
            'setMissingCanvas',
        );

        if (!originalRenderAnnotationElement && !originalSetMissingCanvas) {
            return render();
        }

        if (originalRenderAnnotationElement) {
            mutableUiManager.renderAnnotationElement = (annotation: unknown) => {
                if (isHiddenEditableAnnotationId(getEditableAnnotationId(annotation))) {
                    return undefined;
                }

                return originalRenderAnnotationElement.call(annotationUiManager, annotation);
            };
        }

        if (originalSetMissingCanvas) {
            mutableUiManager.setMissingCanvas = (
                annotationId: string,
                annotationElementId: string,
                canvas: HTMLCanvasElement,
            ) => {
                if (isHiddenEditableAnnotationId(annotationId)) {
                    return undefined;
                }

                return originalSetMissingCanvas.call(
                    annotationUiManager,
                    annotationId,
                    annotationElementId,
                    canvas,
                );
            };
        }

        try {
            return await render();
        } finally {
            if (originalRenderAnnotationElement) {
                mutableUiManager.renderAnnotationElement = originalRenderAnnotationElement.bind(annotationUiManager);
            }
            if (originalSetMissingCanvas) {
                mutableUiManager.setMissingCanvas = originalSetMissingCanvas.bind(annotationUiManager);
            }
        }
    }

    function applyHiddenEditableAnnotationFilter(annotationLayerInstance: TAnnotationLayer | null) {
        if (!annotationLayerInstance) {
            return annotationLayerInstance;
        }

        const getEditableAnnotations =
            getOptionalFunction<[], unknown[]>(annotationLayerInstance, 'getEditableAnnotations');
        const getEditableAnnotation =
            getOptionalFunction<[string], unknown>(annotationLayerInstance, 'getEditableAnnotation');

        if (!getEditableAnnotations && !getEditableAnnotation) {
            return annotationLayerInstance;
        }

        const mutableAnnotationLayer = annotationLayerInstance as TAnnotationLayer & IAnnotationLayerWithEditableAnnotations;

        if (getEditableAnnotations) {
            mutableAnnotationLayer.getEditableAnnotations = () => (
                getEditableAnnotations.call(annotationLayerInstance)
                    .filter(editable => !isHiddenEditableAnnotationId(getEditableAnnotationId(editable)))
            );
        }

        if (getEditableAnnotation) {
            mutableAnnotationLayer.getEditableAnnotation = (annotationId: string) => (
                isHiddenEditableAnnotationId(annotationId)
                    ? null
                    : getEditableAnnotation.call(annotationLayerInstance, annotationId)
            );
        }

        return mutableAnnotationLayer;
    }

    function toPdfjsTextLayerRef(
        textLayerDiv: HTMLDivElement | null,
    ): IPdfjsTextLayerElement | undefined {
        if (!textLayerDiv) {
            return undefined;
        }

        const normalizedTextLayer = textLayerDiv as IPdfjsTextLayerElement;
        try {
            normalizedTextLayer.div = textLayerDiv;
        } catch {
            // Ignore: in that case we'll fall back to a lightweight shim.
        }

        if (normalizedTextLayer.div === textLayerDiv) {
            return normalizedTextLayer;
        }

        return { div: textLayerDiv } as IPdfjsTextLayerElement;
    }

    function syncEditorLayersWithCurrentDocument() {
        const currentDocument = deps.pdfDocument.value;
        if (currentDocument === activeEditorDocument) {
            return;
        }
        activeEditorDocument = currentDocument;
        clearAllLayers();
    }

    function isAnnotationEditorLayerDisabledForCurrentDocument() {
        const currentDocument = deps.pdfDocument.value;
        if (currentDocument) {
            return annotationEditorLayerDisabledDocuments.has(currentDocument);
        }
        return annotationEditorLayerDisabledWithoutDocument;
    }

    function disableAnnotationEditorLayerForCurrentDocument(
        error: unknown,
        pageNumber: number,
    ) {
        const currentDocument = deps.pdfDocument.value;
        if (currentDocument) {
            if (!annotationEditorLayerDisabledDocuments.has(currentDocument)) {
                BrowserLogger.warn(
                    'pdf-annotation-layer',
                    `Disabling annotation editor layer for current document after page ${pageNumber} failure`,
                    error,
                );
            }
            annotationEditorLayerDisabledDocuments.add(currentDocument);
        } else {
            if (!annotationEditorLayerDisabledWithoutDocument) {
                BrowserLogger.warn(
                    'pdf-annotation-layer',
                    `Disabling annotation editor layer without active document after page ${pageNumber} failure`,
                    error,
                );
            }
            annotationEditorLayerDisabledWithoutDocument = true;
        }
        clearAllLayers();
    }

    function removeHiddenAnnotations(annotationLayerDiv: HTMLElement) {
        const hiddenAnnotationIds = getNormalizedHiddenAnnotationIds();
        if (hiddenAnnotationIds.size === 0) {
            return;
        }

        annotationLayerDiv.querySelectorAll<HTMLElement>('[data-annotation-id]').forEach((element) => {
            const annotationId = normalizePdfJsAnnotationId(element.dataset.annotationId);
            if (!annotationId || !hiddenAnnotationIds.has(annotationId)) {
                return;
            }
            element.remove();
        });
    }

    function hideAnnotationEditorLayer(annotationEditorLayerDiv: HTMLElement) {
        annotationEditorLayerDiv.innerHTML = '';
        annotationEditorLayerDiv.hidden = true;
    }

    async function renderAnnotationLayer(
        pdfPage: PDFPageProxy,
        annotationLayerDiv: HTMLElement,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        _pageNumber: number,
        annotationCanvasMap?: Map<string, HTMLCanvasElement> | null,
    ) {
        annotationLayerDiv.innerHTML = '';

        const annotations = await pdfPage.getAnnotations();
        const hiddenAnnotationIds = getNormalizedHiddenAnnotationIds();
        const visibleAnnotations = hiddenAnnotationIds.size === 0
            ? annotations
            : annotations.filter(annotation => {
                const annotationId = normalizePdfJsAnnotationId(getAnnotationId(annotation));
                return !annotationId || !hiddenAnnotationIds.has(annotationId);
            });
        const annotationStorage = deps.pdfDocument.value?.annotationStorage;
        const annotationUiManager = toValue(deps.annotationUiManager) ?? null;

        const simpleLinkService = {
            pagesCount: deps.numPages.value,
            page: deps.currentPage.value,
            rotation: 0,
            isInPresentationMode: false,
            externalLinkEnabled: true,
            goToDestination: async () => {},
            goToPage: (page: number) => deps.scrollToPage?.(page),
            goToXY: () => {},
            addLinkAttributes: (
                link: HTMLAnchorElement,
                url: string,
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
        } as IPDFLinkService;

        const annotationLayerInstance = new AnnotationLayer({
            div: annotationLayerDiv as HTMLDivElement,
            page: pdfPage,
            viewport,
            accessibilityManager: null,
            annotationCanvasMap: annotationCanvasMap ?? null,
            annotationEditorUIManager: annotationUiManager,
            structTreeLayer: null,
            commentManager: null,
            linkService: simpleLinkService,
            annotationStorage,
        });

        await withHiddenAnnotationRenderGuards(annotationUiManager, async () => {
            await annotationLayerInstance.render({
                annotations: visibleAnnotations,
                viewport,
                div: annotationLayerDiv as HTMLDivElement,
                page: pdfPage,
                linkService: simpleLinkService,
                renderForms: false,
                annotationStorage,
            });
        });
        removeHiddenAnnotations(annotationLayerDiv);

        return applyHiddenEditableAnnotationFilter(annotationLayerInstance);
    }

    function renderAnnotationEditorLayer(
        container: HTMLElement,
        annotationEditorLayerDiv: HTMLElement,
        textLayerDiv: HTMLDivElement | null,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        pageNumber: number,
        annotationLayerInstance: TAnnotationLayer | null,
    ) {
        syncEditorLayersWithCurrentDocument();

        const annotationUiManager = toValue(deps.annotationUiManager) ?? null;
        if (
            !annotationUiManager ||
      isAnnotationEditorLayerDisabledForCurrentDocument()
        ) {
            hideAnnotationEditorLayer(annotationEditorLayerDiv);
            return false;
        }

        try {
            const pageMetrics = getAnnotationEditorPageMetrics(viewport);
            const signatures = getAnnotationEditorSignatures(pageNumber);
            const editorLayer = getReusableAnnotationEditorLayer(
                pageNumber,
                signatures,
            );
            const drawLayer = getOrCreateDrawLayer(container, pageNumber);

            if (!editorLayer) {
                prepareAnnotationEditorLayerDiv(
                    annotationEditorLayerDiv,
                    annotationUiManager,
                );
            }

            const activeLayer = renderOrUpdateAnnotationEditorLayer({
                annotationEditorLayerDiv,
                annotationLayerInstance,
                annotationUiManager,
                drawLayer,
                editorLayer,
                pageMetrics,
                pageNumber,
                textLayerDiv,
            });

            applyAnnotationEditorLayerMode(
                annotationEditorLayerDiv,
                annotationUiManager,
                activeLayer,
            );
            saveAnnotationEditorSignatures(pageNumber, signatures);
            annotationEditorLayerContainers.set(pageNumber, container);
            hideHiddenManagedEditors(pageNumber);
            observeHighlightCompositeOverlay(container);
            scheduleHighlightCompositeRefresh(container);
            return true;
        } catch (error) {
            disableAnnotationEditorLayerForCurrentDocument(error, pageNumber);
            hideAnnotationEditorLayer(annotationEditorLayerDiv);
            return false;
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
        if (
            editorLayer
            && (
                signatures.previousHidden !== signatures.hidden
                || signatures.previousManaged !== signatures.managed
            )
        ) {
            cleanupEditorLayer(pageNumber);
            return undefined;
        }

        return editorLayer;
    }

    function getOrCreateDrawLayer(
        container: HTMLElement,
        pageNumber: number,
    ) {
        const drawLayer = drawLayers.get(pageNumber) ?? new DrawLayer();
        const canvasHost = container.querySelector<HTMLDivElement>('.page_canvas');
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

    function renderOrUpdateAnnotationEditorLayer(params: {
        annotationEditorLayerDiv: HTMLElement;
        annotationLayerInstance: TAnnotationLayer | null;
        annotationUiManager: AnnotationEditorUIManager;
        drawLayer: TDrawLayer;
        editorLayer: TAnnotationEditorLayer | undefined;
        pageMetrics: ReturnType<typeof getAnnotationEditorPageMetrics>;
        pageNumber: number;
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
            textLayerDiv,
        } = params;
        const l10n = toValue(deps.annotationL10n) ?? fallbackL10n;
        const textLayerRef = toPdfjsTextLayerRef(textLayerDiv);
        const activeLayer = editorLayer ?? new AnnotationEditorLayer({
            mode: {},
            uiManager: annotationUiManager,
            div: annotationEditorLayerDiv as HTMLDivElement,
            structTreeLayer: null,
            enabled: true,
            accessibilityManager: undefined,
            pageIndex: pageNumber - 1,
            l10n,
            viewport: pageMetrics.editorViewport,
            annotationLayer: annotationLayerInstance ?? undefined,
            // pdfjs-dist type declarations lag runtime shape; runtime expects a textLayer carrying a `div` reference.
            textLayer: textLayerRef,
            drawLayer,
        });

        if (editorLayer) {
            editorLayer.update({ viewport: pageMetrics.editorViewport });
        } else {
            annotationEditorLayers.set(pageNumber, activeLayer);
            void activeLayer.render({ viewport: pageMetrics.editorViewport });
        }

        return activeLayer;
    }

    function scheduleHighlightCompositeRefresh(container: HTMLElement) {
        if (typeof window === 'undefined') {
            refreshHighlightCompositeOverlay(container);
            return;
        }
        window.requestAnimationFrame(() => {
            refreshHighlightCompositeOverlay(container);
        });
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

    function cleanupEditorLayer(pageNumber: number) {
        hiddenAnnotationSignatures.delete(pageNumber);
        managedAnnotationSignatures.delete(pageNumber);
        const container = annotationEditorLayerContainers.get(pageNumber);
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
