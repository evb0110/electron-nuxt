import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { Ref } from 'vue';
import type {
    AnnotationEditorUIManager,
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
import { cast } from '@tests/helpers/cast';

const loggerWarn = vi.fn();
const loggerDebug = vi.fn();

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    warn: loggerWarn,
    warnThrottled: vi.fn(),
    debug: loggerDebug,
    error: vi.fn(),
}}));

const annotationEditorLayerCtor = vi.fn();
const annotationLayerRender = vi.fn(async (_options: unknown) => {});
const annotationEditorLayerRender = vi.fn(async (_options: unknown) => {});
const editorLayerInstances: MockAnnotationEditorLayer[] = [];
const drawLayerInstances: MockDrawLayer[] = [];

afterEach(() => {
    vi.useRealTimers();
});

function createEditableAnnotation(id: string) {
    return {
        data: { id },
        hide: vi.fn(),
        show: vi.fn(),
        updateEdited: vi.fn(),
    };
}

class MockAnnotationLayer {
    public editableAnnotations: Array<ReturnType<typeof createEditableAnnotation>> = [];
    public togglePointerEvents = vi.fn();
    public updateFakeAnnotations = vi.fn();

    getEditableAnnotations() {
        return this.editableAnnotations;
    }

    getEditableAnnotation(id: string) {
        return this.editableAnnotations.find(annotation => annotation.data.id === id) ?? null;
    }

    async render(params?: {
        div?: HTMLDivElement;
        annotations?: Array<{ id?: string | null }>;
    }) {
        this.editableAnnotations = (params?.annotations ?? [])
            .flatMap(annotation => annotation.id ? [createEditableAnnotation(annotation.id)] : []);
        params?.annotations?.forEach((annotation) => {
            if (!params.div || !annotation.id) {
                return;
            }
            cast<{ append: (element: IFakeEditorLayerAnnotationElement) => void }>(params.div)
                .append(createAnnotationElement(annotation.id));
        });
        await annotationLayerRender(params);
    }
}

class MockDrawLayer {
    public setParent = vi.fn();
    public destroy = vi.fn();

    constructor(_params: { pageIndex: number }) {
        drawLayerInstances.push(this);
    }
}

class MockAnnotationEditorLayer {
    public div: HTMLDivElement | null;
    public isInvisible = false;
    public textLayer: unknown;
    public uiManager: {
        addLayer: (layer: MockAnnotationEditorLayer) => void;
        removeLayer?: (layer: MockAnnotationEditorLayer) => void;
    };
    public update = vi.fn();
    public render = vi.fn((options: unknown) => annotationEditorLayerRender(options));
    public pause = vi.fn();

    constructor(params: {
        div: HTMLDivElement;
        textLayer?: unknown;
        uiManager: {
            addLayer: (layer: MockAnnotationEditorLayer) => void;
            removeLayer?: (layer: MockAnnotationEditorLayer) => void;
        };
    }) {
        this.div = params.div;
        this.textLayer = params.textLayer;
        this.uiManager = params.uiManager;
        annotationEditorLayerCtor(params);
        editorLayerInstances.push(this);
        params.uiManager.addLayer(this);
    }

    disable() {
        const textLayer = this.textLayer as
      | { div?: { addEventListener?: (...args: unknown[]) => unknown } }
      | undefined;
        textLayer?.div?.addEventListener?.('pointerdown', () => {});
        if (!textLayer?.div) {
            throw new TypeError(
                'Cannot read properties of undefined (reading addEventListener)',
            );
        }
    }

    enable() {
        return;
    }

    destroy() {
        this.div = null;
        this.uiManager.removeLayer?.(this);
    }
}

class MockAnnotationEditorUIManager {
    get currentLayer() {
        return null;
    }
}

vi.mock('pdfjs-dist', () => ({
    version: '5.7.284',
    AnnotationLayer: MockAnnotationLayer,
    AnnotationEditorLayer: MockAnnotationEditorLayer,
    AnnotationEditorUIManager: MockAnnotationEditorUIManager,
    AnnotationEditorType: {NONE: 0},
    DrawLayer: MockDrawLayer,
}));

const {
    didRenderAnnotationEditorLayer,
    usePdfAnnotationLayerRenderer,
} =
    await import('@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer');

interface IFakeDivElement {
    innerHTML: string;
    dir: string;
    hidden: boolean;
    style: Record<string, string>;
    setAttribute: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    closest?: (selector: string) => unknown;
}

interface IFakeContainerElement {querySelector: ReturnType<typeof vi.fn>;}

interface IViewportLike {
    clone: ReturnType<typeof vi.fn>;
    rawDims?: Record<string, unknown>;
}

interface IFakeEditorLayerAnnotationElement {
    dataset: { annotationId?: string; };
    style: Record<string, string>;
    setAttribute: (name: string, value: string) => void;
    getAttribute: (name: string) => string | null;
}

interface IFakeAnnotationLayerDiv extends IFakeDivElement {
    append: (element: IFakeEditorLayerAnnotationElement) => void;
    querySelectorAll: (selector: string) => IFakeEditorLayerAnnotationElement[];
}

function createDiv(): HTMLDivElement {
    const fakeDiv: IFakeDivElement = {
        innerHTML: '',
        dir: 'ltr',
        hidden: false,
        style: {},
        setAttribute: vi.fn(),
        addEventListener: vi.fn(),
    };
    return cast<HTMLDivElement>(fakeDiv);
}

function createAnnotationElement(annotationId: string): IFakeEditorLayerAnnotationElement {
    const attributes = new Map<string, string>();
    const element: IFakeEditorLayerAnnotationElement = {
        dataset: { annotationId },
        style: {},
        setAttribute: (name, value) => {
            attributes.set(name, value);
        },
        getAttribute: (name) => attributes.get(name) ?? null,
    };
    return element;
}

function createAnnotationLayerDiv(options?: {
    hasShapeOverlay?: boolean;
    shapeOverlayAnnotationIds?: string[];
}): HTMLDivElement {
    const appended: IFakeEditorLayerAnnotationElement[] = [];
    const overlayAnnotationIds = options?.shapeOverlayAnnotationIds
        ?? (options?.hasShapeOverlay ? ['12R'] : []);
    const overlayElements = overlayAnnotationIds.map(createAnnotationElement);
    const querySelector = vi.fn((selector: string) => {
        if (selector === '.pdf-shape-overlay.has-shapes' && overlayElements.length > 0) {
            return {};
        }
        return null;
    });
    const querySelectorAll = vi.fn((selector: string) => {
        if (selector === '.pdf-shape-overlay.has-shapes [data-annotation-id]') {
            return overlayElements;
        }
        return [];
    });
    const pageContainer = {
        querySelector,
        querySelectorAll,
    };
    const fakeDiv: IFakeAnnotationLayerDiv = {
        innerHTML: '',
        dir: 'ltr',
        hidden: false,
        style: {},
        setAttribute: vi.fn(),
        addEventListener: vi.fn(),
        closest: (selector: string) => selector === '.page_container' ? pageContainer : null,
        append: (element) => {
            appended.push(element);
        },
        querySelectorAll: (selector: string) => {
            const exactMatch = selector.match(/^\[data-annotation-id="(.+)"\]$/);
            if (selector === '[data-annotation-id]') {
                return appended;
            }
            if (exactMatch) {
                return appended.filter(element => element.dataset.annotationId === exactMatch[1]);
            }
            return [];
        },
    };
    return cast<HTMLDivElement>(fakeDiv);
}

function createContainer(pageCanvas: HTMLDivElement) {
    const querySelector = vi.fn((selector: string) => {
        if (selector === '.page_canvas') {
            return pageCanvas;
        }
        return null;
    });
    const fakeContainer: IFakeContainerElement = { querySelector };
    return cast<HTMLElement>(fakeContainer);
}

function createViewport(): ReturnType<PDFPageProxy['getViewport']> {
    const viewport: IViewportLike = { clone: vi.fn(() => ({ rawDims: {} })) };
    return cast<ReturnType<PDFPageProxy['getViewport']>>(viewport);
}

function createUiManager(enabled = false) {
    return {
        direction: 'ltr',
        addLayer: vi.fn((layer: MockAnnotationEditorLayer) => {
            if (enabled) {
                layer.enable();
                return;
            }
            layer.disable();
        }),
        removeLayer: vi.fn(),
        getEditors: vi.fn<() => unknown[]>(() => []),
        getActive: vi.fn<() => unknown | null>(() => null),
        setActiveEditor: vi.fn(),
    };
}

function mockUiManagerRef(uiManager: ReturnType<typeof createUiManager>) {
    return cast<Ref<AnnotationEditorUIManager | null>>(ref(uiManager));
}

describe('usePdfAnnotationLayerRenderer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        annotationLayerRender.mockReset();
        annotationLayerRender.mockResolvedValue(undefined);
        annotationEditorLayerRender.mockReset();
        annotationEditorLayerRender.mockResolvedValue(undefined);
        editorLayerInstances.length = 0;
        drawLayerInstances.length = 0;
    });

    it('passes a PDF.js-compatible text layer object to AnnotationEditorLayer', async () => {
        const uiManager = createUiManager(false);
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(1),
            currentPage: ref(1),
            pdfDocument: ref(null),
            showAnnotations: ref(true),
            annotationUiManager: mockUiManagerRef(uiManager),
            annotationL10n: ref(null),
        });

        const pageCanvas = createDiv();
        const container = createContainer(pageCanvas);
        const annotationEditorLayerDiv = createDiv();
        const textLayerDiv = createDiv();

        const result = await renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            textLayerDiv,
            createViewport(),
            1,
            null,
        );

        expect(didRenderAnnotationEditorLayer(result)).toBe(true);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(1);
        const ctorArg = annotationEditorLayerCtor.mock.calls[0]?.[0] as {textLayer?: { div?: HTMLDivElement };} | undefined;
        expect(ctorArg?.textLayer?.div).toBe(textLayerDiv);
        expect(uiManager.addLayer).toHaveBeenCalledTimes(1);
        expect(loggerWarn).not.toHaveBeenCalled();

        const secondResult = await renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            textLayerDiv,
            createViewport(),
            1,
            null,
        );

        expect(didRenderAnnotationEditorLayer(secondResult)).toBe(true);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(1);
        expect(editorLayerInstances[0]?.update).toHaveBeenCalledTimes(1);
    });

    it('detaches and destroys an editor layer whose render settles after abort', async () => {
        const lateRender = Promise.withResolvers<undefined>();
        annotationEditorLayerRender.mockImplementationOnce(() => lateRender.promise);
        const uiManager = createUiManager(true);
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(1),
            currentPage: ref(1),
            pdfDocument: ref(null),
            showAnnotations: ref(true),
            annotationUiManager: mockUiManagerRef(uiManager),
            annotationL10n: ref(null),
        });
        const pageCanvas = createDiv();
        const annotationEditorLayerDiv = createDiv();
        let mountedEditorLayerDiv = annotationEditorLayerDiv;
        const replaceChild = vi.fn((replacement: HTMLDivElement, staleLayer: HTMLElement) => {
            mountedEditorLayerDiv = replacement;
            cast<{ isConnected: boolean }>(staleLayer).isConnected = false;
        });
        const layerParent = { replaceChild };
        Object.assign(annotationEditorLayerDiv, {
            cloneNode: () => createDiv(),
            isConnected: true,
            parentNode: layerParent,
        });
        const querySelector = vi.fn((selector: string) => {
            if (selector === '.page_canvas') {
                return pageCanvas;
            }
            if (selector === '.annotation-editor-layer') {
                return mountedEditorLayerDiv;
            }
            return null;
        });
        const container = cast<HTMLElement>({ querySelector });
        const abortController = new AbortController();

        const renderPromise = renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            null,
            createViewport(),
            1,
            null,
            { signal: abortController.signal },
        );
        await vi.waitFor(() => {
            expect(annotationEditorLayerRender).toHaveBeenCalledTimes(1);
        });

        abortController.abort();
        const result = await renderPromise;
        const replacement = mountedEditorLayerDiv;

        expect(result).toMatchObject({
            ok: true,
            rendered: false,
            reason: 'stale',
        });
        expect(replacement).not.toBe(annotationEditorLayerDiv);
        expect(replacement?.hidden).toBe(true);
        expect(cast<{ isConnected: boolean }>(annotationEditorLayerDiv).isConnected).toBe(false);

        lateRender.resolve(undefined);
        await vi.waitFor(() => {
            expect(uiManager.removeLayer).toHaveBeenCalledWith(editorLayerInstances[0]);
        });
        expect(cast<{ isConnected: boolean }>(annotationEditorLayerDiv).isConnected).toBe(false);
        expect(mountedEditorLayerDiv).toBe(replacement);
        expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('does not let an aborted stale render destroy a replacement manager layer', async () => {
        const lateRender = Promise.withResolvers<undefined>();
        annotationEditorLayerRender
            .mockImplementationOnce(() => lateRender.promise)
            .mockResolvedValueOnce(undefined);
        const firstUiManager = createUiManager(true);
        const secondUiManager = createUiManager(true);
        const uiManagerRef = mockUiManagerRef(firstUiManager);
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(1),
            currentPage: ref(1),
            pdfDocument: ref(null),
            showAnnotations: ref(true),
            annotationUiManager: uiManagerRef,
            annotationL10n: ref(null),
        });
        const firstAbortController = new AbortController();
        const firstRender = renderer.renderAnnotationEditorLayer(
            createContainer(createDiv()),
            createDiv(),
            null,
            createViewport(),
            1,
            null,
            { signal: firstAbortController.signal },
        );
        await vi.waitFor(() => {
            expect(annotationEditorLayerRender).toHaveBeenCalledOnce();
        });

        firstAbortController.abort();
        uiManagerRef.value = cast<AnnotationEditorUIManager>(secondUiManager);
        const replacementRender = renderer.renderAnnotationEditorLayer(
            createContainer(createDiv()),
            createDiv(),
            createDiv(),
            createViewport(),
            1,
            null,
        );

        await expect(firstRender).resolves.toEqual({
            ok: true,
            rendered: false,
            reason: 'stale',
        });
        await expect(replacementRender).resolves.toMatchObject({
            ok: true,
            rendered: true,
        });
        const replacementLayer = editorLayerInstances[1];
        expect(replacementLayer).toBeDefined();
        expect(secondUiManager.removeLayer).not.toHaveBeenCalledWith(replacementLayer);

        lateRender.resolve(undefined);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(secondUiManager.removeLayer).not.toHaveBeenCalledWith(replacementLayer);
        expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('replaces a stuck manager while keeping it isolated until its render settles', async () => {
        vi.useFakeTimers();
        const stuckAnnotationRender = Promise.withResolvers<undefined>();
        annotationLayerRender.mockImplementationOnce(() => stuckAnnotationRender.promise);
        const staleUiManager = Object.assign(createUiManager(true), {
            destroy: vi.fn(),
            removeEditListeners: vi.fn(),
            renderAnnotationElement: vi.fn(),
        });
        const originalRenderAnnotationElement = staleUiManager.renderAnnotationElement;
        const replacementUiManager = createUiManager(true);
        const uiManagerRef = mockUiManagerRef(staleUiManager);
        const replaceAnnotationUiManager = vi.fn((manager: AnnotationEditorUIManager) => {
            const staleManager = cast<typeof staleUiManager>(manager);
            staleManager.removeEditListeners();
            staleManager.destroy();
            uiManagerRef.value = cast<AnnotationEditorUIManager>(replacementUiManager);
        });
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(1),
            currentPage: ref(1),
            pdfDocument: ref(null),
            showAnnotations: ref(true),
            annotationUiManager: uiManagerRef,
            annotationL10n: ref(null),
            replaceAnnotationUiManager,
        });
        const annotationAbortController = new AbortController();
        const annotationRender = renderer.renderAnnotationLayer(
            cast<PDFPageProxy>({ getAnnotations: vi.fn(async () => []) }),
            createAnnotationLayerDiv(),
            createViewport(),
            1,
            null,
            { signal: annotationAbortController.signal },
        ).catch(error => error as Error);
        await vi.waitFor(() => {
            expect(annotationLayerRender).toHaveBeenCalledTimes(1);
        });
        annotationAbortController.abort();
        expect(await annotationRender).toMatchObject({ name: 'AbortError' });
        expect(staleUiManager.renderAnnotationElement).not.toBe(originalRenderAnnotationElement);

        await vi.advanceTimersByTimeAsync(250);
        expect(replaceAnnotationUiManager).toHaveBeenCalledWith(staleUiManager);
        expect(staleUiManager.removeEditListeners).toHaveBeenCalledOnce();
        expect(staleUiManager.destroy).toHaveBeenCalledOnce();
        expect(uiManagerRef.value).not.toBe(staleUiManager);
        expect(staleUiManager.renderAnnotationElement).not.toBe(originalRenderAnnotationElement);

        const container = createContainer(createDiv());
        const replacementResult = await renderer.renderAnnotationEditorLayer(
            container,
            createDiv(),
            createDiv(),
            createViewport(),
            1,
            null,
        );
        expect(didRenderAnnotationEditorLayer(replacementResult)).toBe(true);
        expect(annotationEditorLayerCtor).toHaveBeenCalledOnce();
        expect(replacementUiManager.addLayer).toHaveBeenCalledOnce();

        stuckAnnotationRender.resolve(undefined);
        await vi.waitFor(() => {
            expect(staleUiManager.renderAnnotationElement).toBe(originalRenderAnnotationElement);
        });
        expect(replacementUiManager.removeLayer).not.toHaveBeenCalledWith(editorLayerInstances[0]);
    });

    it('quarantines only the page whose annotation editor layer exhausts retries', async () => {
        const firstDocument = cast<PDFDocumentProxy>({ annotationStorage: {} });
        const secondDocument = cast<PDFDocumentProxy>({ annotationStorage: {} });
        const pdfDocument = cast<Ref<PDFDocumentProxy | null>>(ref(firstDocument));
        const uiManager = createUiManager(false);
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(1),
            currentPage: ref(1),
            pdfDocument,
            showAnnotations: ref(true),
            annotationUiManager: mockUiManagerRef(uiManager),
            annotationL10n: ref(null),
        });

        const pageCanvas = createDiv();
        const container = createContainer(pageCanvas);
        const annotationEditorLayerDiv = createDiv();

        const firstResult = await renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            null,
            createViewport(),
            1,
            null,
        );

        expect(firstResult).toMatchObject({
            ok: false,
            reason: 'render-error',
            retryable: true,
        });
        expect(loggerWarn).toHaveBeenCalledTimes(1);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(1);
        expect(drawLayerInstances[0]?.destroy).toHaveBeenCalledTimes(1);

        const secondResult = await renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            null,
            createViewport(),
            1,
            null,
        );

        expect(secondResult).toMatchObject({
            ok: false,
            reason: 'render-error',
            retryable: false,
        });
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(2);
        expect(annotationEditorLayerDiv.hidden).toBe(true);

        const quarantinedResult = await renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            createDiv(),
            createViewport(),
            1,
            null,
        );

        expect(quarantinedResult).toEqual({
            ok: true,
            rendered: false,
            reason: 'quarantined',
        });
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(2);
        expect(annotationEditorLayerDiv.hidden).toBe(true);

        const pageTwoResult = await renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            createDiv(),
            createViewport(),
            2,
            null,
        );

        expect(didRenderAnnotationEditorLayer(pageTwoResult)).toBe(true);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(3);

        pdfDocument.value = secondDocument;

        const afterDocumentChangeResult = await renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            createDiv(),
            createViewport(),
            1,
            null,
        );

        expect(didRenderAnnotationEditorLayer(afterDocumentChangeResult)).toBe(true);
        expect(loggerWarn).toHaveBeenCalledTimes(2);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(4);
    });

    it('suppresses imported embedded annotations before they are added to the annotation layer DOM', async () => {
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(1),
            currentPage: ref(1),
            pdfDocument: ref(null),
            showAnnotations: ref(true),
            hiddenAnnotationIds: ref(new Set(['12R0'])),
            annotationUiManager: mockUiManagerRef(createUiManager(false)),
            annotationL10n: ref(null),
        });

        const annotationLayerDiv = createAnnotationLayerDiv();
        const pdfPage = cast<PDFPageProxy>({ getAnnotations: vi.fn(async () => [{ id: '12R' }]) });

        await renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            createViewport(),
            1,
        );

        const hiddenElement = annotationLayerDiv.querySelectorAll('[data-annotation-id="12R"]')[0] as IFakeEditorLayerAnnotationElement | undefined;
        expect(hiddenElement).toBeUndefined();
    });

    it('keeps managed embedded annotations visible until the shape overlay is mounted', async () => {
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(1),
            currentPage: ref(1),
            pdfDocument: ref(null),
            showAnnotations: ref(true),
            hiddenAnnotationIds: ref(new Set(['12R0'])),
            managedAnnotationIds: ref(new Set(['12R'])),
            annotationUiManager: mockUiManagerRef(createUiManager(false)),
            annotationL10n: ref(null),
        });

        const annotationLayerDiv = createAnnotationLayerDiv({ hasShapeOverlay: false });
        const pdfPage = cast<PDFPageProxy>({ getAnnotations: vi.fn(async () => [{ id: '12R' }]) });

        await renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            createViewport(),
            1,
        );

        const managedElement = annotationLayerDiv.querySelectorAll('[data-annotation-id="12R"]')[0] as IFakeEditorLayerAnnotationElement | undefined;
        expect(managedElement).toBeDefined();
    });

    it('suppresses managed embedded annotations once the shape overlay is mounted', async () => {
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(1),
            currentPage: ref(1),
            pdfDocument: ref(null),
            showAnnotations: ref(true),
            hiddenAnnotationIds: ref(new Set(['12R0'])),
            managedAnnotationIds: ref(new Set(['12R'])),
            annotationUiManager: mockUiManagerRef(createUiManager(false)),
            annotationL10n: ref(null),
        });

        const annotationLayerDiv = createAnnotationLayerDiv({ hasShapeOverlay: true });
        const pdfPage = cast<PDFPageProxy>({ getAnnotations: vi.fn(async () => [{ id: '12R' }]) });

        await renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            createViewport(),
            1,
        );

        const managedElement = annotationLayerDiv.querySelectorAll('[data-annotation-id="12R"]')[0] as IFakeEditorLayerAnnotationElement | undefined;
        expect(managedElement).toBeUndefined();
    });

    it('keeps managed embedded annotations in the PDF.js editor hydration source until the shape overlay is mounted', async () => {
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(1),
            currentPage: ref(1),
            pdfDocument: ref(null),
            showAnnotations: ref(true),
            hiddenAnnotationIds: ref(new Set([
                '12R0',
                '12R',
            ])),
            managedAnnotationIds: ref(new Set(['12R'])),
            annotationUiManager: mockUiManagerRef(createUiManager(false)),
            annotationL10n: ref(null),
        });

        const annotationLayerDiv = createAnnotationLayerDiv({ hasShapeOverlay: false });
        const pdfPage = cast<PDFPageProxy>({ getAnnotations: vi.fn(async () => [
            { id: '12R' },
            { id: '42R' },
        ]) });

        const annotationLayer = await renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            createViewport(),
            1,
        ) as {
            getEditableAnnotations?: () => Array<{ data: { id: string; }; }>;
            getEditableAnnotation?: (id: string) => unknown;
        } | null;

        expect(annotationLayer?.getEditableAnnotations?.().map(annotation => annotation.data.id)).toEqual([
            '12R',
            '42R',
        ]);
        expect(annotationLayer?.getEditableAnnotation?.('12R')).not.toBeNull();
    });

    it('suppresses hidden managed annotations from the PDF.js editor hydration source', async () => {
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(1),
            currentPage: ref(1),
            pdfDocument: ref(null),
            showAnnotations: ref(true),
            hiddenAnnotationIds: ref(new Set([
                '12R0',
                '12R',
            ])),
            annotationUiManager: mockUiManagerRef(createUiManager(false)),
            annotationL10n: ref(null),
        });

        const annotationLayerDiv = createAnnotationLayerDiv();
        const pdfPage = cast<PDFPageProxy>({ getAnnotations: vi.fn(async () => [
            { id: '12R' },
            { id: '42R' },
        ]) });

        const annotationLayer = await renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            createViewport(),
            1,
        ) as {
            getEditableAnnotations?: () => Array<{ data: { id: string; }; }>;
            getEditableAnnotation?: (id: string) => unknown;
        } | null;

        expect(annotationLayer?.getEditableAnnotations?.().map(annotation => annotation.data.id)).toEqual(['42R']);
        expect(annotationLayer?.getEditableAnnotation?.('12R')).toBeNull();
        expect(annotationLayer?.getEditableAnnotation?.('42R')).not.toBeNull();
    });

    it('rebuilds the editor layer when managed hidden annotation ids change', async () => {
        const hiddenAnnotationIds = ref<Set<string>>(new Set());
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(1),
            currentPage: ref(1),
            pdfDocument: ref(null),
            showAnnotations: ref(true),
            hiddenAnnotationIds,
            annotationUiManager: mockUiManagerRef(createUiManager(false)),
            annotationL10n: ref(null),
        });

        const pageCanvas = createDiv();
        const container = createContainer(pageCanvas);
        const annotationEditorLayerDiv = createDiv();
        const textLayerDiv = createDiv();

        const firstResult = await renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            textLayerDiv,
            createViewport(),
            1,
            null,
        );

        expect(didRenderAnnotationEditorLayer(firstResult)).toBe(true);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(1);

        hiddenAnnotationIds.value = new Set(['12R0']);

        const secondResult = await renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            textLayerDiv,
            createViewport(),
            1,
            null,
        );

        expect(didRenderAnnotationEditorLayer(secondResult)).toBe(true);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(2);
        expect(drawLayerInstances[0]?.destroy).toHaveBeenCalledTimes(1);
    });

    it('rebuilds the editor layer when managed annotation ownership changes even if hidden ids stay the same', async () => {
        const hiddenAnnotationIds = ref<Set<string>>(new Set([
            '12R',
            '42R',
        ]));
        const managedAnnotationIds = ref<Set<string>>(new Set(['12R']));
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(1),
            currentPage: ref(1),
            pdfDocument: ref(null),
            showAnnotations: ref(true),
            hiddenAnnotationIds,
            managedAnnotationIds,
            annotationUiManager: mockUiManagerRef(createUiManager(false)),
            annotationL10n: ref(null),
        });

        const pageCanvas = createDiv();
        const container = createContainer(pageCanvas);
        const annotationEditorLayerDiv = createDiv();
        const textLayerDiv = createDiv();

        const firstResult = await renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            textLayerDiv,
            createViewport(),
            1,
            null,
        );

        expect(didRenderAnnotationEditorLayer(firstResult)).toBe(true);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(1);

        managedAnnotationIds.value = new Set(['42R']);

        const secondResult = await renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            textLayerDiv,
            createViewport(),
            1,
            null,
        );

        expect(didRenderAnnotationEditorLayer(secondResult)).toBe(true);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(2);
        expect(drawLayerInstances[0]?.destroy).toHaveBeenCalledTimes(1);
    });

    it('hides already-hydrated hidden managed editors and clears their editable annotation visuals', () => {
        const hiddenEditable = createEditableAnnotation('12R');
        const visibleEditable = createEditableAnnotation('42R');
        const hiddenEditor = {
            annotationElementId: '12R0',
            pageIndex: 0,
            show: vi.fn(),
            disableEditing: vi.fn(),
            parent: {getEditableAnnotation: vi.fn((annotationId: string) => (
                annotationId === '12R'
                    ? hiddenEditable
                    : null
            ))},
        };
        const visibleEditor = {
            annotationElementId: '42R',
            pageIndex: 0,
            show: vi.fn(),
            disableEditing: vi.fn(),
            parent: {getEditableAnnotation: vi.fn((annotationId: string) => (
                annotationId === '42R'
                    ? visibleEditable
                    : null
            ))},
        };
        const uiManager = createUiManager(false);
        uiManager.getEditors.mockReturnValue([
            hiddenEditor,
            visibleEditor,
        ]);
        uiManager.getActive.mockReturnValue(hiddenEditor);

        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(1),
            currentPage: ref(1),
            pdfDocument: ref(null),
            showAnnotations: ref(true),
            hiddenAnnotationIds: ref(new Set(['12R'])),
            annotationUiManager: mockUiManagerRef(uiManager),
            annotationL10n: ref(null),
        });

        renderer.hideHiddenManagedEditors(1);

        expect(hiddenEditor.show).toHaveBeenCalledWith(false);
        expect(hiddenEditor.disableEditing).toHaveBeenCalledTimes(1);
        expect(hiddenEditable.hide).toHaveBeenCalledTimes(1);
        expect(uiManager.setActiveEditor).toHaveBeenCalledWith(null);

        expect(visibleEditor.show).not.toHaveBeenCalled();
        expect(visibleEditor.disableEditing).not.toHaveBeenCalled();
        expect(visibleEditable.hide).not.toHaveBeenCalled();
    });
});
