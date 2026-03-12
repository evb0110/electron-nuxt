import {
    AnnotationLayer,
    AnnotationEditorLayer,
    AnnotationEditorType,
    DrawLayer,
} from 'pdfjs-dist';
import type {
    IL10n,
    IPDFLinkService,
} from 'pdfjs-dist/types/web/interfaces';
import type {
    PDFPageProxy,
    AnnotationEditorUIManager,
    PDFDocumentProxy,
} from 'pdfjs-dist';
import type {
    MaybeRefOrGetter,
    Ref,
} from 'vue';
import { defaultDocument } from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browser-logger';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/electron';

interface IAnnotationEditorLayerProto {
    disable?: (...args: unknown[]) => unknown;
    destroy?: (...args: unknown[]) => unknown;
    __evbSafetyPatchApplied?: boolean;
}

interface IPdfjsTextLayerElement extends HTMLDivElement {div: HTMLDivElement;}

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
    annotationUiManager: MaybeRefOrGetter<AnnotationEditorUIManager | null>;
    annotationL10n: MaybeRefOrGetter<IL10n | null>;
    scrollToPage?: (pageNumber: number) => void;
}) => {
    ensureAnnotationEditorLayerSafetyPatch();

    const annotationEditorLayers = new Map<number, AnnotationEditorLayer>();
    const drawLayers = new Map<number, DrawLayer>();
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

    async function renderAnnotationLayer(
        pdfPage: PDFPageProxy,
        annotationLayerDiv: HTMLElement,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        _pageNumber: number,
    ) {
        annotationLayerDiv.innerHTML = '';

        const annotations = await pdfPage.getAnnotations();
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
                link.href = url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.addEventListener('click', (event) => {
                    event.preventDefault();
                    if (hasElectronAPI()) {
                        void getElectronAPI().shell.openExternal(url).catch((error) => {
                            BrowserLogger.warn(
                                'pdf-annotation-layer',
                                `Failed to open annotation link: ${url}`,
                                error,
                            );
                        });
                    } else {
                        const openedWindow = window.open(
                            url,
                            '_blank',
                            'noopener,noreferrer',
                        );
                        if (!openedWindow) {
                            BrowserLogger.warn(
                                'pdf-annotation-layer',
                                `Failed to open annotation link in browser: ${url}`,
                            );
                        }
                    }
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
            annotationCanvasMap: null,
            annotationEditorUIManager: annotationUiManager,
            structTreeLayer: null,
            commentManager: null,
            linkService: simpleLinkService,
            annotationStorage,
        });

        await annotationLayerInstance.render({
            annotations,
            viewport,
            div: annotationLayerDiv as HTMLDivElement,
            page: pdfPage,
            linkService: simpleLinkService,
            renderForms: false,
            annotationStorage,
        });

        return annotationLayerInstance;
    }

    function renderAnnotationEditorLayer(
        container: HTMLElement,
        annotationEditorLayerDiv: HTMLElement,
        textLayerDiv: HTMLDivElement | null,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        pageNumber: number,
        annotationLayerInstance: AnnotationLayer | null,
    ) {
        syncEditorLayersWithCurrentDocument();

        const annotationUiManager = toValue(deps.annotationUiManager) ?? null;
        if (
            !annotationUiManager ||
      isAnnotationEditorLayerDisabledForCurrentDocument()
        ) {
            annotationEditorLayerDiv.innerHTML = '';
            annotationEditorLayerDiv.hidden = true;
            return false;
        }

        try {
            const editorViewport = viewport.clone({ dontFlip: true });
            const editorLayer = annotationEditorLayers.get(pageNumber);
            const drawLayer =
                drawLayers.get(pageNumber) ??
        new DrawLayer();

            const canvasHost =
                container.querySelector<HTMLDivElement>('.page_canvas');
            if (canvasHost) {
                drawLayer.setParent(canvasHost);
            }
            drawLayers.set(pageNumber, drawLayer);

            if (!editorLayer) {
                annotationEditorLayerDiv.innerHTML = '';
                const direction: unknown = annotationUiManager.direction;
                if (direction === 'ltr' || direction === 'rtl' || direction === 'auto') {
                    annotationEditorLayerDiv.dir = direction;
                }
            }

            const l10n = toValue(deps.annotationL10n) ?? fallbackL10n;
            const textLayerRef = toPdfjsTextLayerRef(textLayerDiv);
            const activeLayer =
                editorLayer ??
        new AnnotationEditorLayer({
            mode: {},
            uiManager: annotationUiManager,
            div: annotationEditorLayerDiv as HTMLDivElement,
            structTreeLayer: null,
            enabled: true,
            accessibilityManager: undefined,
            pageIndex: pageNumber - 1,
            l10n,
            viewport: editorViewport,
            annotationLayer: annotationLayerInstance ?? undefined,
            // pdfjs-dist type declarations lag runtime shape; runtime expects a textLayer carrying a `div` reference.
            textLayer: textLayerRef,
            drawLayer,
        });

            if (!editorLayer) {
                annotationEditorLayers.set(pageNumber, activeLayer);
            }

            if (editorLayer) {
                editorLayer.update({ viewport: editorViewport });
            } else {
                activeLayer.render({ viewport: editorViewport });
            }

            const currentMode =
                typeof annotationUiManager.getMode === 'function'
                    ? annotationUiManager.getMode()
                    : AnnotationEditorType.NONE;
            const shouldHideLayer =
                currentMode === AnnotationEditorType.NONE && activeLayer.isInvisible;

            annotationEditorLayerDiv.hidden = shouldHideLayer;
            activeLayer.pause(shouldHideLayer);
            return true;
        } catch (error) {
            disableAnnotationEditorLayerForCurrentDocument(error, pageNumber);
            annotationEditorLayerDiv.innerHTML = '';
            annotationEditorLayerDiv.hidden = true;
            return false;
        }
    }

    function cleanupEditorLayer(pageNumber: number) {
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
    }

    return {
        renderAnnotationLayer,
        renderAnnotationEditorLayer,
        cleanupEditorLayer,
        clearAllLayers,
    };
};
