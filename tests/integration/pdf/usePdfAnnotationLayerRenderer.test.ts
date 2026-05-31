import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    type Ref,
} from 'vue';
import type {
    AnnotationEditorUIManager,
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
import { cast } from '../../helpers/cast';

const loggerWarn = vi.fn();
const loggerDebug = vi.fn();

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    warn: loggerWarn,
    warnThrottled: vi.fn(),
    debug: loggerDebug,
    error: vi.fn(),
}}));

const annotationEditorLayerCtor = vi.fn();
const editorLayerInstances: MockAnnotationEditorLayer[] = [];
const drawLayerInstances: MockDrawLayer[] = [];

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
            cast<{ append: (element: IFakeAnnotationElement) => void }>(params.div)
                .append(createAnnotationElement(annotation.id));
        });
        return;
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
    public render = vi.fn();
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

vi.mock('pdfjs-dist', () => ({
    AnnotationLayer: MockAnnotationLayer,
    AnnotationEditorLayer: MockAnnotationEditorLayer,
    AnnotationEditorType: {NONE: 0},
    DrawLayer: MockDrawLayer,
}));

const { usePdfAnnotationLayerRenderer } =
    await import('@app/composables/pdf/usePdfAnnotationLayerRenderer');

interface IFakeDivElement {
    innerHTML: string;
    dir: string;
    hidden: boolean;
    style: Record<string, string>;
    setAttribute: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
}

interface IFakeContainerElement {querySelector: ReturnType<typeof vi.fn>;}

interface IViewportLike {
    clone: ReturnType<typeof vi.fn>;
    rawDims?: Record<string, unknown>;
}

interface IFakeAnnotationElement {
    dataset: { annotationId?: string; };
    style: Record<string, string>;
    setAttribute: (name: string, value: string) => void;
    getAttribute: (name: string) => string | null;
}

interface IFakeAnnotationLayerDiv extends IFakeDivElement {
    append: (element: IFakeAnnotationElement) => void;
    querySelectorAll: (selector: string) => IFakeAnnotationElement[];
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

function createAnnotationElement(annotationId: string): IFakeAnnotationElement {
    const attributes = new Map<string, string>();
    const element: IFakeAnnotationElement = {
        dataset: { annotationId },
        style: {},
        setAttribute: (name: string, value: string) => {
            attributes.set(name, value);
        },
        getAttribute: (name: string) => attributes.get(name) ?? null,
    };
    return element;
}

function createAnnotationLayerDiv(): HTMLDivElement {
    const appended: IFakeAnnotationElement[] = [];
    const fakeDiv: IFakeAnnotationLayerDiv = {
        innerHTML: '',
        dir: 'ltr',
        hidden: false,
        style: {},
        setAttribute: vi.fn(),
        addEventListener: vi.fn(),
        append: (element: IFakeAnnotationElement) => {
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

function createContainer(pageCanvas: HTMLDivElement): HTMLElement {
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

        expect(result).toBe(true);
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

        expect(secondResult).toBe(true);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(1);
        expect(editorLayerInstances[0]?.update).toHaveBeenCalledTimes(1);
    });

    it('disables the annotation editor layer for the current document after a render crash', async () => {
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

        expect(firstResult).toBe(false);
        expect(loggerWarn).toHaveBeenCalledTimes(1);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(1);
        expect(drawLayerInstances[0]?.destroy).toHaveBeenCalledTimes(1);

        const secondResult = await renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            createDiv(),
            createViewport(),
            1,
            null,
        );

        expect(secondResult).toBe(false);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(1);
        expect(annotationEditorLayerDiv.hidden).toBe(true);

        pdfDocument.value = secondDocument;

        const thirdResult = await renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            createDiv(),
            createViewport(),
            1,
            null,
        );

        expect(thirdResult).toBe(true);
        expect(loggerWarn).toHaveBeenCalledTimes(1);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(2);
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

        const hiddenElement = annotationLayerDiv.querySelectorAll('[data-annotation-id="12R"]')[0] as IFakeAnnotationElement | undefined;
        expect(hiddenElement).toBeUndefined();
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

        expect(firstResult).toBe(true);
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

        expect(secondResult).toBe(true);
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

        expect(firstResult).toBe(true);
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

        expect(secondResult).toBe(true);
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
