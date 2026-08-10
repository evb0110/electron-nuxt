// @vitest-environment happy-dom

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
import { shouldIgnoreEditorEvent } from '@app/modules/pdf-viewer/engine/annotations/annotation-editor-event-guards/shouldIgnoreEditorEvent';
import { getPdfjsEditorFacadeState } from '@app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import type {IPdfjsAnnotationEditorState} from '@app/modules/pdf-viewer/runtime/annotations/pdfjsAnnotationState';
import { cast } from '@tests/helpers/cast';

const {
    annotationUiManagerInstances,
    FakeAnnotationEditorLayer,
    FakeAnnotationEditorUIManager,
} = vi.hoisted(() => {
    const instances: unknown[] = [];
    class HoistedAnnotationEditorUIManager {
        __addToAnnotationStorageSpy = vi.fn((editor?: {
            __assignAnnotationElementIdOnStorage?: boolean;
            annotationElementId?: string | null;
        }) => {
            if (editor?.__assignAnnotationElementIdOnStorage) editor.annotationElementId = 'generated-annotation-id';
        });
        addToAnnotationStorage = this.__addToAnnotationStorageSpy;
        __addCommandsSpy = vi.fn();
        addCommands = this.__addCommandsSpy;
        addEditListeners = vi.fn(); copy = vi.fn(); cut = vi.fn(); destroy = vi.fn(); delete = vi.fn();
        getEditors = vi.fn(() => []); keydown = vi.fn(); keyup = vi.fn(); onPageChanging = vi.fn();
        onScaleChanging = vi.fn(); paste = vi.fn(async () => {}); redo = vi.fn(); removeEditListeners = vi.fn();
        registerEditorTypes = vi.fn(); undo = vi.fn(); unselectAll = vi.fn(); updateParams = vi.fn();
        __setSelectedSpy = vi.fn(); setSelected = this.__setSelectedSpy;
        get currentLayer() { return null; }
        constructor(..._args: unknown[]) { instances.push(this); }
    }
    class HoistedAnnotationEditorLayer { disable() {} destroy() {} }
    return {
        annotationUiManagerInstances: instances as HoistedAnnotationEditorUIManager[],
        FakeAnnotationEditorLayer: HoistedAnnotationEditorLayer,
        FakeAnnotationEditorUIManager: HoistedAnnotationEditorUIManager,
    };
});

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

    dispatch(name: string, event: unknown) {
        this.listeners.get(name)?.forEach(listener => listener(event));
    }
}

function FakeGenericL10n() {}

vi.mock('@app/services/pdfjs/runtimeLib', () => ({
    default: {
        version: '5.7.284',
        AnnotationEditorLayer: FakeAnnotationEditorLayer,
    },
    AnnotationEditorParamsType: {
        CREATE: 0,
        HIGHLIGHT_SHOW_ALL: 1,
    },
    AnnotationEditorLayer: FakeAnnotationEditorLayer,
    AnnotationEditorUIManager: FakeAnnotationEditorUIManager,
    PixelsPerInch: { PDF_TO_CSS_UNITS: 1 },
}));

vi.mock('@app/services/pdfjs/getPdfjsViewerRuntimeProbeFailures', () => ({
    EventBus: FakeEventBus,
    GenericL10n: FakeGenericL10n,
}));

function createAnnotationSettings(): IAnnotationSettings {
    return {
        highlightColor: '#ffff00',
        highlightOpacity: 0.6,
        highlightThickness: 12,
        highlightFreehandEnabled: false,
        showAllHighlights: true,
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
    toolToMarkupSubtype: Partial<Record<TAnnotationTool, TMarkupSubtype>>;
    shouldForceTextMarkup: (tool: TAnnotationTool) => boolean;
    applyHighlightParamsForTool: (mgr: AnnotationEditorUIManager, s: IAnnotationSettings, t: TAnnotationTool) => void;
    resolveEditorMarkupSubtypeOverride: (e: IPdfjsEditor, pi: number) => TMarkupSubtype | null;
    resolveEditorSubtypeFromPresentation: (e: IPdfjsEditor) => TMarkupSubtype | null;
    setEditorMarkupSubtypeOverride: (e: IPdfjsEditor, pi: number, s: TMarkupSubtype) => void;
    clearOverrides: () => void;
}

async function createBridgeHarness(
    tool: TAnnotationTool = 'draw',
    options?: {
        autoResetTo?: TAnnotationTool | null;
        markupSubtype?: Partial<IMarkupSubtypeHarness>;
    },
) {
    const { useAnnotationEditorBridge } = await import('@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationEditorBridge');
    const container = document.createElement('div');
    document.body.append(container);

    const annotationUiManager = shallowRef<AnnotationEditorUIManager | null>(null);
    const annotationL10n = shallowRef(null);
    const pdfDocument = shallowRef<PDFDocumentProxy | null>({ annotationStorage: {} } as PDFDocumentProxy);
    const emitAnnotationModified = vi.fn();
    const emitAnnotationState = vi.fn<(patch: Partial<IPdfjsAnnotationEditorState>) => void>();
    const emitAnnotationOpenNote = vi.fn<(comment: IAnnotationCommentSummary) => void>();
    const recordPdfjsExecutorCommand = vi.fn();
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
    const textMarkupPresentation = {notify: vi.fn()};

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
        recordPdfjsExecutorCommand,
        textMarkupPresentation,
    });

    bridge.initAnnotationEditor();

    const uiManager = annotationUiManager.value;
    if (!(uiManager instanceof FakeAnnotationEditorUIManager)) {
        throw new Error('Expected FakeAnnotationEditorUIManager instance');
    }
    const eventBus = bridge.annotationEventBus.value;
    if (!(eventBus instanceof FakeEventBus)) {
        throw new Error('Expected FakeEventBus instance');
    }

    return {
        emitAnnotationModified,
        emitAnnotationState,
        markupSubtype,
        recordPdfjsExecutorCommand,
        scheduleAnnotationCommentsSync,
        textMarkupPresentation,
        uiManager,
        eventBus,
    };
}

function createMarkupSubtypeHarness(overrides?: Partial<IMarkupSubtypeHarness>) {
    return {
        toolToMarkupSubtype: {},
        shouldForceTextMarkup: vi.fn<IMarkupSubtypeHarness['shouldForceTextMarkup']>(() => false),
        applyHighlightParamsForTool: vi.fn<IMarkupSubtypeHarness['applyHighlightParamsForTool']>(),
        resolveEditorMarkupSubtypeOverride: vi.fn<IMarkupSubtypeHarness['resolveEditorMarkupSubtypeOverride']>(() => null),
        resolveEditorSubtypeFromPresentation: vi.fn<IMarkupSubtypeHarness['resolveEditorSubtypeFromPresentation']>(() => null),
        setEditorMarkupSubtypeOverride: vi.fn<IMarkupSubtypeHarness['setEditorMarkupSubtypeOverride']>(),
        clearOverrides: vi.fn<IMarkupSubtypeHarness['clearOverrides']>(),
        ...overrides,
    };
}

describe('shouldIgnoreEditorEvent', () => {
    beforeEach(() => {
        document.body.replaceChildren();
        annotationUiManagerInstances.length = 0;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('ignores note-window key events when the active element is a textarea', () => {
        const activeTextarea = document.createElement('textarea');
        activeTextarea.classList.add('note-window');
        document.body.append(activeTextarea);
        activeTextarea.focus();

        const event = new Event('keydown');
        Object.defineProperty(event, 'target', {
            configurable: true,
            value: document.body,
        });

        expect(shouldIgnoreEditorEvent(event)).toBe(true);
    });

    it('does not ignore non-editing key events outside text entry surfaces', () => {
        const activeButton = document.createElement('button');
        document.body.append(activeButton);
        activeButton.focus();

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
        document.body.replaceChildren();
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('forwards PDF.js annotation state patches without owning merged state', async () => {
        const {
            emitAnnotationState,
            eventBus,
        } = await createBridgeHarness('text');
        emitAnnotationState.mockClear();

        eventBus.dispatch('annotationeditorstateschanged', {details: {isEditing: true}});
        eventBus.dispatch('annotationeditorstateschanged', {details: {hasSomethingToUndo: true}});

        expect(emitAnnotationState).toHaveBeenNthCalledWith(1, {isEditing: true});
        expect(emitAnnotationState).toHaveBeenNthCalledWith(2, {hasSomethingToUndo: true});
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
        } = await createBridgeHarness('underline', { markupSubtype: { toolToMarkupSubtype: { underline: 'Underline' } } });
        const editor = {
            id: 'highlight-1',
            div: document.createElement('div'),
            annotationElementId: '42R0',
            parentPageIndex: 0,
            isEmpty: vi.fn(() => false),
        };
        editor.div.className = 'highlightEditor';

        uiManager.addToAnnotationStorage(editor);

        expect(markupSubtype.setEditorMarkupSubtypeOverride).not.toHaveBeenCalled();
    });

    it('keeps new text markup creation out of the parallel PDF.js undo stack', async () => {
        const {
            recordPdfjsExecutorCommand,
            uiManager,
        } = await createBridgeHarness('underline', { markupSubtype: { toolToMarkupSubtype: { underline: 'Underline' } } });
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

        expect(uiManager.__addCommandsSpy).not.toHaveBeenCalled();
        expect(parentAddCommands).not.toHaveBeenCalled();
        expect(recordPdfjsExecutorCommand).not.toHaveBeenCalled();
        expect(getPdfjsEditorFacadeState(editor).creationHistoryRegistered).toBeUndefined();
        expect(editor.annotationElementId).toBe('generated-annotation-id');
        expect(remove).not.toHaveBeenCalled();
        expect(rebuild).not.toHaveBeenCalled();
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

    it('syncs annotation projections when app history replays a PDF.js command', async () => {
        const {
            emitAnnotationModified,
            recordPdfjsExecutorCommand,
            scheduleAnnotationCommentsSync,
            uiManager,
        } = await createBridgeHarness('text');
        const cmd = vi.fn();
        const undo = vi.fn();

        uiManager.addCommands(cast<Parameters<AnnotationEditorUIManager['addCommands']>[0]>({
            cmd,
            undo,
        }));
        const command = recordPdfjsExecutorCommand.mock.calls[0]?.[0];
        emitAnnotationModified.mockClear();
        scheduleAnnotationCommentsSync.mockClear();

        command.undo();
        command.cmd();

        expect(undo).toHaveBeenCalledOnce();
        expect(cmd).toHaveBeenCalledOnce();
        expect(emitAnnotationModified).toHaveBeenCalledTimes(2);
        expect(scheduleAnnotationCommentsSync).toHaveBeenNthCalledWith(1, true);
        expect(scheduleAnnotationCommentsSync).toHaveBeenNthCalledWith(2, true);
    });

});
