import {
    AnnotationLayer,
    AnnotationEditorLayer,
    AnnotationEditorUIManager as RuntimeAnnotationEditorUIManager,
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
    IPdfjsL10n,
    IPdfjsLinkService,
} from '@app/types/pdfjs';
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
import {
    combinePdfLayerVisualSnapshotReleases,
    hasPdfPageAnnotationVisualContentForSnapshotRelease,
    hasPdfPageDrawLayerVisualContent,
    preservePdfLayerVisualSnapshot,
    preservePdfPageAnnotationVisualSnapshot,
    schedulePdfLayerVisualSnapshotRelease,
} from '@app/composables/pdf/pdfLayerVisualSnapshot';
import {
    tracePdfAnnotationSaveDom,
    tracePdfAnnotationSaveEvent,
} from '@app/composables/pdf/pdfAnnotationSaveTrace';
import { clearPdfSelectionForLayerTeardown } from '@app/composables/pdf/pdfSelectionCleanup';
import { getOptionalFunction } from '@app/services/pdfjs/runtime';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getShellCapability } from '@app/utils/platformShell';
import { normalizeAllowedExternalUrl } from '@contracts/externalUrl';

interface IAnnotationEditorLayerProto {
    disable?: (...args: unknown[]) => unknown;
    destroy?: (...args: unknown[]) => unknown;
    __evbSafetyPatchApplied?: boolean;
}

interface IAnnotationEditorUiManagerProto {__evbCurrentLayerSafetyPatchApplied?: boolean;}

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
    getEditableAnnotations?: () => Iterable<unknown>;
    getEditableAnnotation?: (id: string) => unknown;
}

interface IAnnotationLayerRenderOptions {shouldContinue?: () => boolean;}

let annotationEditorLayerSafetyPatched = false;
let annotationEditorUiManagerSafetyPatched = false;
let destroyedEditorLayerFallbackDiv: HTMLDivElement | null = null;
let missingCurrentEditorLayerFallback: Record<string, unknown> | null = null;
const hiddenAnnotationGuardQueues = new WeakMap<
    AnnotationEditorUIManager,
    Promise<unknown>
>();

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

function getMissingCurrentEditorLayerFallback() {
    if (missingCurrentEditorLayerFallback) {
        return missingCurrentEditorLayerFallback;
    }

    const fallbackDiv = getDestroyedEditorLayerFallbackDiv();
    if (!fallbackDiv) {
        return null;
    }

    missingCurrentEditorLayerFallback = {
        pageIndex: -1,
        div: fallbackDiv,
        hasTextLayer: () => false,
        canCreateNewEmptyEditor: () => false,
        addNewEditor: () => undefined,
        createAndAddNewEditor: () => null,
        toggleDrawing: () => undefined,
        deserialize: () => Promise.resolve(null),
        pasteEditor: () => undefined,
        endDrawingSession: () => null,
        pause: () => undefined,
        disable: () => undefined,
        enable: () => Promise.resolve(undefined),
        update: () => undefined,
        destroy: () => undefined,
    };
    return missingCurrentEditorLayerFallback;
}

function ensureAnnotationEditorUiManagerSafetyPatch() {
    if (annotationEditorUiManagerSafetyPatched) {
        return;
    }

    const proto = RuntimeAnnotationEditorUIManager?.prototype as
        | IAnnotationEditorUiManagerProto
        | undefined;
    if (!proto || proto.__evbCurrentLayerSafetyPatchApplied) {
        annotationEditorUiManagerSafetyPatched = true;
        return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(proto, 'currentLayer');
    if (typeof descriptor?.get !== 'function') {
        annotationEditorUiManagerSafetyPatched = true;
        return;
    }

    const originalGetter = descriptor.get;
    try {
        Object.defineProperty(proto, 'currentLayer', {
            ...descriptor,
            get() {
                const layer = originalGetter.call(this) as unknown;
                return layer ?? getMissingCurrentEditorLayerFallback();
            },
        });
        proto.__evbCurrentLayerSafetyPatchApplied = true;
    } catch (error) {
        BrowserLogger.debug(
            'pdf-annotation-layer',
            'Failed to patch missing annotation editor current layer guard',
            error,
        );
    } finally {
        annotationEditorUiManagerSafetyPatched = true;
    }
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
    annotationL10n: MaybeRefOrGetter<IPdfjsL10n | null>;
    scrollToPage?: (pageNumber: number) => void;
}) => {
    ensureAnnotationEditorLayerSafetyPatch();
    ensureAnnotationEditorUiManagerSafetyPatch();

    const annotationEditorLayers = new Map<number, TAnnotationEditorLayer>();
    const drawLayers = new Map<number, TDrawLayer>();
    const annotationEditorLayerContainers = new Map<number, HTMLElement>();
    const annotationEditorLayerRefreshRafIds = new Map<number, number>();
    const hiddenAnnotationSignatures = new Map<number, string>();
    const managedAnnotationSignatures = new Map<number, string>();
    const annotationEditorLayerDisabledDocuments =
        new WeakSet<PDFDocumentProxy>();
    let annotationEditorLayerDisabledWithoutDocument = false;
    let activeEditorDocument: PDFDocumentProxy | null = deps.pdfDocument.value;
    let activeAnnotationUiManager: AnnotationEditorUIManager | null =
        toValue(deps.annotationUiManager) ?? null;
    let annotationLayerRenderToken = 0;
    const annotationLayerPageRenderTokens = new Map<number, number>();
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

        const previousGuard = hiddenAnnotationGuardQueues.get(annotationUiManager)
            ?? Promise.resolve();
        const queuedGuard = (async () => {
            try {
                await previousGuard;
            } catch {
                // Previous guarded renders report their own errors.
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
                    mutableUiManager.renderAnnotationElement = originalRenderAnnotationElement;
                }
                if (originalSetMissingCanvas) {
                    mutableUiManager.setMissingCanvas = originalSetMissingCanvas;
                }
            }
        })();
        const queueTail = queuedGuard.catch(() => {});
        hiddenAnnotationGuardQueues.set(annotationUiManager, queueTail);
        try {
            return await queuedGuard;
        } finally {
            if (hiddenAnnotationGuardQueues.get(annotationUiManager) === queueTail) {
                hiddenAnnotationGuardQueues.delete(annotationUiManager);
            }
        }

    }

    function applyHiddenEditableAnnotationFilter(annotationLayerInstance: TAnnotationLayer | null) {
        if (!annotationLayerInstance) {
            return annotationLayerInstance;
        }

        const getEditableAnnotations =
            getOptionalFunction<[], Iterable<unknown>>(annotationLayerInstance, 'getEditableAnnotations');
        const getEditableAnnotation =
            getOptionalFunction<[string], unknown>(annotationLayerInstance, 'getEditableAnnotation');

        if (!getEditableAnnotations && !getEditableAnnotation) {
            return annotationLayerInstance;
        }

        const mutableAnnotationLayer = annotationLayerInstance as IAnnotationLayerWithEditableAnnotations;

        if (getEditableAnnotations) {
            mutableAnnotationLayer.getEditableAnnotations = () => (
                Array.from(getEditableAnnotations.call(annotationLayerInstance))
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

        return annotationLayerInstance;
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

    function syncEditorLayersWithCurrentDocument(
        pageContainer?: HTMLElement | null,
        annotationEditorLayerDiv?: HTMLElement | null,
    ) {
        const currentDocument = deps.pdfDocument.value;
        const currentUiManager = toValue(deps.annotationUiManager) ?? null;
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
        clearAllLayers();
        tracePdfAnnotationSaveDom(
            'editor-layer:document-ui-manager-changed:after-clear',
            pageContainer ?? null,
        );
        return snapshotRelease;
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

    function shouldContinueLayerRender(options?: IAnnotationLayerRenderOptions) {
        return options?.shouldContinue?.() !== false;
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
            const annotations = await pdfPage.getAnnotations();
            tracePdfAnnotationSaveEvent(
                'annotation-layer:get-annotations:resolved',
                {
                    annotations: annotations.length,
                    pageNumber,
                    renderToken,
                },
            );
            if (annotationLayerPageRenderTokens.get(pageNumber) !== renderToken) {
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
            if (!shouldContinueLayerRender(options)) {
                annotationLayerDiv.innerHTML = '';
                return null;
            }
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
                goToPage: (page: number | string) => {
                    if (typeof page === 'number') {
                        deps.scrollToPage?.(page);
                    }
                },
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
            } satisfies IPdfjsLinkService;

            const annotationLayerInstance = new AnnotationLayer({
                div: annotationLayerDiv as HTMLDivElement,
                page: pdfPage,
                viewport,
                accessibilityManager: null,
                annotationCanvasMap: annotationCanvasMap ?? null,
                annotationEditorUIManager: annotationUiManager,
                structTreeLayer: null,
                commentManager: null,
                linkService: simpleLinkService as never,
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
            await withHiddenAnnotationRenderGuards(annotationUiManager, async () => {
                await annotationLayerInstance.render({
                    annotations: visibleAnnotations,
                    viewport,
                    div: annotationLayerDiv as HTMLDivElement,
                    page: pdfPage,
                    linkService: simpleLinkService as never,
                    renderForms: false,
                    annotationStorage,
                });
            });
            if (
                annotationLayerPageRenderTokens.get(pageNumber) !== renderToken
                || !shouldContinueLayerRender(options)
            ) {
                annotationLayerDiv.innerHTML = '';
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

            return applyHiddenEditableAnnotationFilter(annotationLayerInstance);
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
            return false;
        }
        tracePdfAnnotationSaveDom(
            'editor-layer:render:start',
            container,
            { pageNumber },
        );
        let shouldWaitForDrawLayerVisuals =
            hasPdfPageDrawLayerVisualContent(container);
        let snapshotRelease = syncEditorLayersWithCurrentDocument(
            container,
            annotationEditorLayerDiv,
        );

        try {
            const annotationUiManager = toValue(deps.annotationUiManager) ?? null;
            if (!shouldContinueLayerRender(options)) {
                return false;
            }
            if (
                !annotationUiManager ||
                isAnnotationEditorLayerDisabledForCurrentDocument()
            ) {
                hideAnnotationEditorLayer(annotationEditorLayerDiv);
                tracePdfAnnotationSaveDom(
                    'editor-layer:render:hidden-no-ui-manager',
                    container,
                    { pageNumber },
                );
                return false;
            }

            const pageMetrics = getAnnotationEditorPageMetrics(viewport);
            const signatures = getAnnotationEditorSignatures(pageNumber);
            if (!shouldContinueLayerRender(options)) {
                return false;
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

            const activeLayer = await renderOrUpdateAnnotationEditorLayer({
                annotationEditorLayerDiv,
                annotationLayerInstance,
                annotationUiManager,
                drawLayer,
                editorLayer,
                pageMetrics,
                pageNumber,
                textLayerDiv,
            });
            if (!shouldContinueLayerRender(options)) {
                cleanupEditorLayer(pageNumber);
                return false;
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
            return true;
        } catch (error) {
            tracePdfAnnotationSaveDom(
                'editor-layer:render:error',
                container,
                {
                    error: error instanceof Error ? error.message : String(error),
                    pageNumber,
                },
            );
            disableAnnotationEditorLayerForCurrentDocument(error, pageNumber);
            hideAnnotationEditorLayer(annotationEditorLayerDiv);
            return false;
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
            cleanupEditorLayer(pageNumber);
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

    async function renderOrUpdateAnnotationEditorLayer(params: {
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
            structTreeLayer: null as never,
            enabled: true,
            accessibilityManager: undefined,
            pageIndex: pageNumber - 1,
            l10n: l10n as never,
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
            await Promise.resolve(activeLayer.render({ viewport: pageMetrics.editorViewport }));
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

    function cleanupEditorLayer(pageNumber: number) {
        cancelHighlightCompositeRefresh(pageNumber);
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
