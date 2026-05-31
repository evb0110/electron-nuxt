import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import {
    ref,
    shallowRef,
} from 'vue';
import { shouldIgnoreEditorEvent } from '@app/composables/pdf/annotations/annotationEditorEventGuards';
import { updateEditorDefaultParams } from '@app/services/pdfjs/annotationEditorAdapter';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationSettings,
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { PDFDocumentProxy } from '@app/types/pdf';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { cast } from '../../../../helpers/cast';

const annotationUiManagerInstances: FakeAnnotationEditorUIManager[] = [];

class FakeAnnotationEditorUIManager {
    __addToAnnotationStorageSpy = vi.fn((editor?: {
        __assignAnnotationElementIdOnStorage?: boolean;
        annotationElementId?: string | null;
    }) => {
        if (editor?.__assignAnnotationElementIdOnStorage) {
            editor.annotationElementId = 'generated-annotation-id';
        }
    });
    addToAnnotationStorage = this.__addToAnnotationStorageSpy;
    __addCommandsSpy = vi.fn();
    addCommands = this.__addCommandsSpy;
    addEditListeners = vi.fn();
    copy = vi.fn();
    cut = vi.fn();
    destroy = vi.fn();
    delete = vi.fn();
    getEditors = vi.fn(() => []);
    keydown = vi.fn();
    keyup = vi.fn();
    onPageChanging = vi.fn();
    onScaleChanging = vi.fn();
    paste = vi.fn(async () => {});
    redo = vi.fn();
    removeEditListeners = vi.fn();
    registerEditorTypes = vi.fn();
    undo = vi.fn();
    unselectAll = vi.fn();
    updateParams = vi.fn();
    __setSelectedSpy = vi.fn();

    setSelected = this.__setSelectedSpy;

    constructor(..._args: unknown[]) {
        annotationUiManagerInstances.push(this);
    }
}

function asAnnotationEditorUIManager(uiManager: FakeAnnotationEditorUIManager) {
    return cast<AnnotationEditorUIManager>(uiManager);
}

class FakeEventBus {
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    on(name: string, listener: (event: unknown) => void) {
        const listeners = this.listeners.get(name) ?? new Set();
        listeners.add(listener);
        this.listeners.set(name, listeners);
    }

    off(name: string, listener: (event: unknown) => void) {
        this.listeners.get(name)?.delete(listener);
    }
}

function FakeGenericL10n() {}

vi.mock('@app/services/pdfjs/runtimeLib', () => ({
    AnnotationEditorParamsType: {
        CREATE: 0,
        HIGHLIGHT_SHOW_ALL: 1,
    },
    AnnotationEditorUIManager: FakeAnnotationEditorUIManager,
    PixelsPerInch: { PDF_TO_CSS_UNITS: 1 },
}));

vi.mock('@app/services/pdfjs/viewerRuntimeLib', () => ({
    EventBus: FakeEventBus,
    GenericL10n: FakeGenericL10n,
}));

class FakeElement {
    tagName: string;
    isContentEditable = false;
    private readonly selectors = new Set<string>();

    constructor(tagName: string, selectors: string[] = []) {
        this.tagName = tagName.toUpperCase();
        selectors.forEach(selector => this.selectors.add(selector));
    }

    closest(selector: string) {
        return this.selectors.has(selector) ? this : null;
    }
}

class FakeDomElement extends FakeElement {
    className = '';
    children: FakeDomElement[] = [];
    style: Record<string, string> = {};
    attributes = new Map<string, string>();
    parent: FakeDomElement | null = null;
    innerHTML = '';

    append(...children: FakeDomElement[]) {
        children.forEach((child) => {
            child.parent = this;
            this.children.push(child);
        });
    }

    remove() {
        if (!this.parent) {
            return;
        }
        this.parent.children = this.parent.children.filter(child => child !== this);
        this.parent = null;
    }

    setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
    }

    removeAttribute(name: string) {
        this.attributes.delete(name);
    }

    contains(node: FakeDomElement | null): boolean {
        if (!node) {
            return false;
        }
        if (node === this) {
            return true;
        }
        return this.children.some((child): boolean => child.contains(node));
    }
}

function createAnnotationSettings(): IAnnotationSettings {
    return {
        highlightColor: '#ffff00',
        highlightOpacity: 0.6,
        highlightThickness: 12,
        highlightFree: false,
        highlightShowAll: true,
        underlineColor: '#00ff00',
        underlineOpacity: 0.7,
        strikethroughColor: '#ff0000',
        strikethroughOpacity: 0.8,
        squigglyColor: '#0000ff',
        squigglyOpacity: 0.5,
        inkColor: '#111111',
        inkOpacity: 0.9,
        inkThickness: 2,
        textColor: '#222222',
        textSize: 14,
        shapeColor: '#333333',
        shapeFillColor: '#444444',
        shapeOpacity: 0.4,
        shapeStrokeWidth: 3,
    };
}

interface IMarkupSubtypeHarness {
    TOOL_TO_MARKUP_SUBTYPE: Partial<Record<TAnnotationTool, TMarkupSubtype>>;
    shouldForceTextMarkup: (tool: TAnnotationTool) => boolean;
    applyHighlightParamsForTool: (mgr: AnnotationEditorUIManager, s: IAnnotationSettings, t: TAnnotationTool) => void;
    resolveEditorMarkupSubtypeOverride: (e: IPdfjsEditor, pi: number) => TMarkupSubtype | null;
    resolveEditorSubtypeFromPresentation: (e: IPdfjsEditor) => TMarkupSubtype | null;
    setEditorMarkupSubtypeOverride: (e: IPdfjsEditor, pi: number, s: TMarkupSubtype) => void;
    clearMarkupSubtypeEditorClass: (e: IPdfjsEditor) => void;
    applyEditorMarkupSubtypePresentation: (e: IPdfjsEditor, s: TMarkupSubtype | null) => void;
    syncMarkupSubtypePresentationForEditors: () => void;
    clearOverrides: () => void;
}

async function createBridgeHarness(
    tool: TAnnotationTool = 'draw',
    options?: {
        autoResetTo?: TAnnotationTool | null;
        markupSubtype?: Partial<IMarkupSubtypeHarness>;
    },
) {
    const { useAnnotationEditorBridge } = await import('@app/composables/pdf/annotations/useAnnotationEditorBridge');
    const container = document.createElement('div');
    document.body.append(container);

    const annotationUiManager = shallowRef<AnnotationEditorUIManager | null>(null);
    const annotationL10n = shallowRef(null);
    const pdfDocument = shallowRef<PDFDocumentProxy | null>({ annotationStorage: {} } as PDFDocumentProxy);
    const emitAnnotationModified = vi.fn();
    const emitAnnotationState = vi.fn<(state: IAnnotationEditorState) => void>();
    const emitAnnotationOpenNote = vi.fn<(comment: IAnnotationCommentSummary) => void>();
    const recordPdfjsHistoryCommand = vi.fn();
    const annotationTool = ref<TAnnotationTool>(tool);
    const pendingAnnotationTool = ref<TAnnotationTool>(tool);
    const maybeAutoResetAnnotationTool = vi.fn(() => {
        if (!options?.autoResetTo) {
            return;
        }

        annotationTool.value = options.autoResetTo;
        pendingAnnotationTool.value = options.autoResetTo;
    });
    const scheduleAnnotationCommentsSync = vi.fn();
    const markupSubtype = createMarkupSubtypeHarness(options?.markupSubtype);

    const bridge = useAnnotationEditorBridge({
        viewerContainer: ref(container),
        pdfDocument,
        numPages: ref(1),
        currentPage: ref(1),
        effectiveScale: ref(1),
        annotationTool,
        annotationUiManager,
        annotationL10n,
        getIdentity: () => ({
            getEditorIdentity: vi.fn(() => 'editor-identity'),
            hydrateSummaryFromMemory: vi.fn(summary => summary),
        }),
        getCommentSync: () => ({
            toEditorSummary: vi.fn(),
            setActiveCommentStableKey: vi.fn(),
            scheduleAnnotationCommentsSync,
            incrementSyncToken: vi.fn(),
            clearSyncState: vi.fn(),
            trackedCreatedEditors: new WeakSet<object>(),
        }),
        getToolManager: () => ({
            pendingAnnotationTool,
            pendingAnnotationSettings: ref<IAnnotationSettings | null>(createAnnotationSettings()),
            applyAnnotationSettings: vi.fn(),
            setAnnotationTool: vi.fn(async () => {}),
            maybeAutoResetAnnotationTool,
            captureHighlightEditorClassFromTypes: vi.fn(),
            enforceHighlightDefaultsForNewEditor: vi.fn(),
        }),
        getMarkupSubtype: () => markupSubtype,
        getFreeTextResize: () => ({
            ensureFreeTextEditorCanResize: vi.fn(),
            patchResizableFreeTextEditors: vi.fn(),
        }),
        emitAnnotationModified,
        emitAnnotationState,
        emitAnnotationOpenNote,
        recordPdfjsHistoryCommand,
    });

    bridge.initAnnotationEditor();

    const uiManager = annotationUiManager.value;
    if (!(uiManager instanceof FakeAnnotationEditorUIManager)) {
        throw new Error('Expected FakeAnnotationEditorUIManager instance');
    }

    return {
        emitAnnotationModified,
        emitAnnotationState,
        markupSubtype,
        recordPdfjsHistoryCommand,
        scheduleAnnotationCommentsSync,
        uiManager,
    };
}

function createMarkupSubtypeHarness(overrides?: Partial<IMarkupSubtypeHarness>) {
    return {
        TOOL_TO_MARKUP_SUBTYPE: {},
        shouldForceTextMarkup: vi.fn<IMarkupSubtypeHarness['shouldForceTextMarkup']>(() => false),
        applyHighlightParamsForTool: vi.fn<IMarkupSubtypeHarness['applyHighlightParamsForTool']>(),
        resolveEditorMarkupSubtypeOverride: vi.fn<IMarkupSubtypeHarness['resolveEditorMarkupSubtypeOverride']>(() => null),
        resolveEditorSubtypeFromPresentation: vi.fn<IMarkupSubtypeHarness['resolveEditorSubtypeFromPresentation']>(() => null),
        setEditorMarkupSubtypeOverride: vi.fn<IMarkupSubtypeHarness['setEditorMarkupSubtypeOverride']>(),
        clearMarkupSubtypeEditorClass: vi.fn<IMarkupSubtypeHarness['clearMarkupSubtypeEditorClass']>(),
        applyEditorMarkupSubtypePresentation: vi.fn<IMarkupSubtypeHarness['applyEditorMarkupSubtypePresentation']>(),
        syncMarkupSubtypePresentationForEditors: vi.fn<IMarkupSubtypeHarness['syncMarkupSubtypePresentationForEditors']>(),
        clearOverrides: vi.fn<IMarkupSubtypeHarness['clearOverrides']>(),
        ...overrides,
    };
}

describe('shouldIgnoreEditorEvent', () => {
    beforeEach(() => {
        vi.stubGlobal('HTMLElement', FakeElement);
        annotationUiManagerInstances.length = 0;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('ignores note-window key events when the active element is a textarea', () => {
        const activeTextarea = new FakeElement('textarea', ['.note-window, .pdf-annotation-note-window']);
        vi.stubGlobal('document', {
            activeElement: activeTextarea,
            getSelection: () => null,
        });

        const event = new Event('keydown');
        Object.defineProperty(event, 'target', {
            configurable: true,
            value: new FakeElement('body'),
        });

        expect(shouldIgnoreEditorEvent(event)).toBe(true);
    });

    it('does not ignore non-editing key events outside text entry surfaces', () => {
        const activeButton = new FakeElement('button');
        vi.stubGlobal('document', {
            activeElement: activeButton,
            getSelection: () => null,
        });

        const event = new Event('keydown');
        Object.defineProperty(event, 'target', {
            configurable: true,
            value: activeButton,
        });

        expect(shouldIgnoreEditorEvent(event)).toBe(false);
    });
});

describe('useAnnotationEditorBridge', () => {
    beforeEach(() => {
        annotationUiManagerInstances.length = 0;
        vi.stubGlobal('HTMLElement', FakeDomElement);
        vi.stubGlobal('window', { requestAnimationFrame: (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        } });
        vi.stubGlobal('document', {
            body: new FakeDomElement('body'),
            createElement: (tagName: string) => new FakeDomElement(tagName),
            getSelection: () => null,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('clears selection after committing a new ink editor', async () => {
        const { uiManager } = await createBridgeHarness('draw');
        const editor = {
            id: 'ink-1',
            div: document.createElement('div'),
            annotationElementId: null,
            parentPageIndex: 0,
            isEmpty: vi.fn(() => false),
        };
        editor.div.className = 'inkEditor';

        uiManager.addToAnnotationStorage(editor);

        expect(uiManager.unselectAll).toHaveBeenCalledOnce();
        expect(uiManager.__setSelectedSpy).toHaveBeenCalledWith(null);
    });

    it('keeps a new ink editor selected after auto-resetting into selection mode', async () => {
        const { uiManager } = await createBridgeHarness('draw', { autoResetTo: 'select' });
        const editor = {
            id: 'ink-2',
            div: document.createElement('div'),
            annotationElementId: null,
            parentPageIndex: 0,
            isEmpty: vi.fn(() => false),
        };
        editor.div.className = 'inkEditor';

        uiManager.addToAnnotationStorage(editor);

        expect(uiManager.unselectAll).not.toHaveBeenCalled();
        expect(uiManager.__setSelectedSpy).not.toHaveBeenCalledWith(null);
    });

    it('keeps non-ink editor selection handling unchanged', async () => {
        const { uiManager } = await createBridgeHarness('text');
        const editor = {
            id: 'text-1',
            div: document.createElement('div'),
            annotationElementId: null,
            parentPageIndex: 0,
            isEmpty: vi.fn(() => false),
        };
        editor.div.className = 'freeTextEditor';

        uiManager.addToAnnotationStorage(editor);

        expect(uiManager.unselectAll).not.toHaveBeenCalled();
        expect(uiManager.__setSelectedSpy).not.toHaveBeenCalledWith(null);
    });

    it('does not infer the active underline tool for an existing PDF highlight editor', async () => {
        const {
            markupSubtype,
            uiManager,
        } = await createBridgeHarness('underline', { markupSubtype: { TOOL_TO_MARKUP_SUBTYPE: { underline: 'Underline' } } });
        const editor = {
            id: 'highlight-1',
            div: document.createElement('div'),
            annotationElementId: '42R0',
            parentPageIndex: 0,
            isEmpty: vi.fn(() => false),
        };
        editor.div.className = 'highlightEditor';

        uiManager.addToAnnotationStorage(editor);

        const applyPresentation = vi.mocked(markupSubtype.applyEditorMarkupSubtypePresentation);
        expect(markupSubtype.setEditorMarkupSubtypeOverride).not.toHaveBeenCalled();
        expect(applyPresentation.mock.calls.map(call => call[1])).not.toContain('Underline');
    });

    it('registers PDF.js undo history for new text markup editors created through storage', async () => {
        const {
            markupSubtype,
            recordPdfjsHistoryCommand,
            uiManager,
        } = await createBridgeHarness('underline', { markupSubtype: { TOOL_TO_MARKUP_SUBTYPE: { underline: 'Underline' } } });
        const remove = vi.fn();
        const rebuild = vi.fn();
        const parentAddCommands = vi.fn();
        const editorDiv = document.createElement('div');
        const editor: IPdfjsEditor & { __assignAnnotationElementIdOnStorage: boolean } = {
            id: 'highlight-2',
            div: editorDiv,
            annotationElementId: null,
            __assignAnnotationElementIdOnStorage: true,
            parentPageIndex: 0,
            isEmpty: vi.fn(() => false),
            parent: { addCommands: parentAddCommands },
            remove,
            _uiManager: { rebuild },
        };
        editorDiv.className = 'highlightEditor';

        uiManager.addToAnnotationStorage(editor);

        expect(uiManager.__addCommandsSpy).toHaveBeenCalledTimes(1);
        expect(parentAddCommands).not.toHaveBeenCalled();
        expect(recordPdfjsHistoryCommand).toHaveBeenCalledTimes(1);
        expect(recordPdfjsHistoryCommand).toHaveBeenCalledWith({ overwriteIfSameType: true });
        expect(editor.__evbCreationHistoryRegistered).toBe(true);
        expect(editor.annotationElementId).toBe('generated-annotation-id');

        const command = uiManager.__addCommandsSpy.mock.calls[0]?.[0];
        expect(command).toMatchObject({
            __evbSkipAppHistory: true,
            mustExec: false,
        });
        const clearMarkupSubtypeEditorClass = vi.mocked(markupSubtype.clearMarkupSubtypeEditorClass);
        const applyEditorMarkupSubtypePresentation = vi.mocked(markupSubtype.applyEditorMarkupSubtypePresentation);
        command.undo();
        expect(clearMarkupSubtypeEditorClass.mock.calls[0]?.[0]).toBe(editor);
        applyEditorMarkupSubtypePresentation.mockClear();
        command.cmd();

        expect(remove).toHaveBeenCalledOnce();
        expect(rebuild.mock.calls[0]?.[0]).toBe(editor);
        expect(applyEditorMarkupSubtypePresentation.mock.calls.some(call => call[1] === 'Underline')).toBe(true);
    });

    it('installs a default-param updater for toolbar settings', async () => {
        const { uiManager } = await createBridgeHarness('text');
        const editorType = { updateDefaultParams: vi.fn() };

        uiManager.registerEditorTypes([editorType]);

        expect(updateEditorDefaultParams(asAnnotationEditorUIManager(uiManager), 31, '#2563eb')).toBe(true);
        expect(editorType.updateDefaultParams).toHaveBeenCalledWith(31, '#2563eb');
    });

    it('syncs annotation mutation state after deleting through the UI manager', async () => {
        const {
            emitAnnotationModified,
            scheduleAnnotationCommentsSync,
            uiManager,
        } = await createBridgeHarness('text');

        uiManager.delete();

        expect(emitAnnotationModified).toHaveBeenCalledOnce();
        expect(scheduleAnnotationCommentsSync).toHaveBeenCalledWith();
    });
});
