import pdfjsRuntime, {
    AnnotationEditorLayer,
    AnnotationEditorUIManager,
    AnnotationLayer,
    DrawLayer,
    TextLayer,
} from '@app/services/pdfjs/runtimeLib';
import type {
    AnnotationEditorUIManager as TAnnotationEditorUIManager,
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
import type { AnnotationLayer as TAnnotationLayer } from 'pdfjs-dist/types/src/display/annotation_layer';
import type { DrawLayer as TDrawLayer } from 'pdfjs-dist/types/src/display/draw_layer';
import type { EventBus as TEventBus } from 'pdfjs-dist/types/web/event_utils';
import type { GenericL10n as TGenericL10n } from 'pdfjs-dist/types/web/genericl10n';
import type {
    IPdfjsL10n,
    IPdfjsLinkService,
} from '@app/types/pdfjs';

interface IPdfjsAnnotationEditorUiManagerCapabilities {
    cleanUndoStack?: ((type: unknown) => unknown) | undefined;
    delete?: (() => unknown) | undefined;
    hasSelection?: boolean | undefined;
    registerEditorTypes?: ((types: readonly unknown[]) => unknown) | undefined;
}

export interface ICreatePdfjsUiManagerOptions {
    container: HTMLElement;
    viewer?: HTMLElement | undefined;
    viewerAlert?: unknown;
    altTextManager?: unknown;
    commentManager?: unknown;
    signatureManager?: unknown;
    eventBus: TEventBus;
    document: PDFDocumentProxy;
    pageColors?: unknown;
    highlightColors: string;
    enableHighlightFloatingButton?: boolean;
    enableUpdatedAddImage?: boolean;
    enableNewAltTextWhenAddingImage?: boolean;
    mlManager?: unknown;
    editorUndoBar?: unknown;
    supportsPinchToZoom?: boolean;
}

export interface ICreatePdfjsAnnotationLayerOptions {
    div: HTMLDivElement;
    page: PDFPageProxy;
    viewport: ReturnType<PDFPageProxy['getViewport']>;
    annotationCanvasMap?: Map<string, HTMLCanvasElement> | null | undefined;
    annotationEditorUiManager: TAnnotationEditorUIManager | null;
    linkService: IPdfjsLinkService;
    annotationStorage?: PDFDocumentProxy['annotationStorage'] | undefined;
}

export interface IRenderPdfjsAnnotationLayerOptions {
    annotations: Awaited<ReturnType<PDFPageProxy['getAnnotations']>>;
    div: HTMLDivElement;
    page: PDFPageProxy;
    viewport: ReturnType<PDFPageProxy['getViewport']>;
    linkService: IPdfjsLinkService;
    annotationStorage?: PDFDocumentProxy['annotationStorage'] | undefined;
    renderForms: boolean;
}

export interface ICreatePdfjsEditorLayerOptions {
    div: HTMLDivElement;
    uiManager: TAnnotationEditorUIManager;
    pageIndex: number;
    l10n: IPdfjsL10n;
    viewport: ReturnType<PDFPageProxy['getViewport']>;
    annotationLayer?: TAnnotationLayer | undefined;
    textLayer?: { div: HTMLDivElement } | undefined;
    drawLayer: TDrawLayer;
}

function getUiManagerCapabilities(uiManager: TAnnotationEditorUIManager) {
    return uiManager as TAnnotationEditorUIManager & IPdfjsAnnotationEditorUiManagerCapabilities;
}

export function createPdfjsEventBus(EventBus: new () => TEventBus) {
    return new EventBus();
}

export function getPdfjsEditorCompatibilityRuntime() {
    return {
        version: pdfjsRuntime.version,
        AnnotationEditorLayer,
        AnnotationEditorUIManager,
    };
}

export function createPdfjsGenericL10n(GenericL10n: new (lang: undefined) => TGenericL10n) {
    return new GenericL10n(undefined);
}

export function createPdfjsUiManager(options: ICreatePdfjsUiManagerOptions) {
    return new AnnotationEditorUIManager(
        options.container,
        options.viewer ?? options.container,
        options.viewerAlert ?? null,
        options.altTextManager ?? null,
        options.commentManager ?? null,
        options.signatureManager ?? null,
        options.eventBus,
        options.document,
        options.pageColors ?? null,
        options.highlightColors,
        options.enableHighlightFloatingButton ?? false,
        options.enableUpdatedAddImage ?? false,
        options.enableNewAltTextWhenAddingImage ?? false,
        options.mlManager ?? null,
        options.editorUndoBar ?? null,
        options.supportsPinchToZoom ?? false,
    );
}

export function createPdfjsAnnotationLayer(options: ICreatePdfjsAnnotationLayerOptions) {
    return new AnnotationLayer({
        div: options.div,
        page: options.page,
        viewport: options.viewport,
        accessibilityManager: null,
        annotationCanvasMap: options.annotationCanvasMap ?? null,
        annotationEditorUIManager: options.annotationEditorUiManager,
        structTreeLayer: null,
        commentManager: null,
        linkService: options.linkService as never,
        annotationStorage: options.annotationStorage,
    });
}

export function renderPdfjsAnnotationLayer(
    layer: TAnnotationLayer,
    options: IRenderPdfjsAnnotationLayerOptions,
) {
    return layer.render({
        annotations: options.annotations,
        viewport: options.viewport,
        div: options.div,
        page: options.page,
        linkService: options.linkService as never,
        renderForms: options.renderForms,
        annotationStorage: options.annotationStorage,
    });
}

export function createPdfjsDrawLayer() {
    return new DrawLayer();
}

export function createPdfjsEditorLayer(options: ICreatePdfjsEditorLayerOptions) {
    return new AnnotationEditorLayer({
        mode: {},
        uiManager: options.uiManager,
        div: options.div,
        structTreeLayer: null as never,
        enabled: true,
        accessibilityManager: undefined,
        pageIndex: options.pageIndex,
        l10n: options.l10n as never,
        viewport: options.viewport,
        annotationLayer: options.annotationLayer,
        textLayer: options.textLayer as never,
        drawLayer: options.drawLayer,
    });
}

export function createPdfjsTextLayer(
    options: ConstructorParameters<typeof TextLayer>[0],
) {
    return new TextLayer(options);
}

export function interceptPdfjsRegisterEditorTypes(
    uiManager: TAnnotationEditorUIManager,
    onRegister: (types: readonly unknown[]) => void,
) {
    const capabilities = getUiManagerCapabilities(uiManager);
    if (typeof capabilities.registerEditorTypes !== 'function') {
        return false;
    }
    const originalRegisterEditorTypes = capabilities.registerEditorTypes.bind(uiManager);
    capabilities.registerEditorTypes = (types: readonly unknown[]) => {
        onRegister(types);
        return originalRegisterEditorTypes(types);
    };
    return true;
}

export function interceptPdfjsCleanUndoStack(
    uiManager: TAnnotationEditorUIManager,
    onClean: (type: number) => void,
) {
    const capabilities = getUiManagerCapabilities(uiManager);
    if (typeof capabilities.cleanUndoStack !== 'function') {
        return false;
    }
    const originalCleanUndoStack = capabilities.cleanUndoStack.bind(uiManager);
    capabilities.cleanUndoStack = (type) => {
        const result = originalCleanUndoStack(type);
        if (typeof type === 'number') {
            onClean(type);
        }
        return result;
    };
    return true;
}

export function interceptPdfjsDelete(
    uiManager: TAnnotationEditorUIManager,
    afterDelete: () => void,
) {
    const capabilities = getUiManagerCapabilities(uiManager);
    if (typeof capabilities.delete !== 'function') {
        return false;
    }
    const originalDelete = capabilities.delete.bind(uiManager);
    capabilities.delete = () => {
        const result = originalDelete();
        afterDelete();
        return result;
    };
    return true;
}

export function hasSelectedPdfjsEditor(uiManager: TAnnotationEditorUIManager) {
    return Boolean(getUiManagerCapabilities(uiManager).hasSelection);
}
