// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import { useAnnotationHighlight } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationHighlight';

vi.mock('pdfjs-dist', () => ({AnnotationEditorType: {FREETEXT: 3}}));

interface IAnnotationHighlightTestRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

function withRect<T extends HTMLElement>(
    element: T,
    rect: IAnnotationHighlightTestRect,
) {
    Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            right: rect.left + rect.width,
            bottom: rect.top + rect.height,
            x: rect.left,
            y: rect.top,
            toJSON: () => ({}),
        }),
    });
    return element;
}

function createPageContainer(page: number, rect: IAnnotationHighlightTestRect) {
    const element = withRect(document.createElement('div'), rect);
    element.className = 'page_container';
    element.dataset.page = String(page);
    return element;
}

function createViewerContainer(pages: HTMLElement[]) {
    const viewer = document.createElement('div');
    viewer.append(...pages);
    return viewer;
}

function createHighlightHarness(viewerContainer: HTMLElement) {
    return useAnnotationHighlight({
        viewerContainer: ref(viewerContainer),
        annotationUiManager: shallowRef(null),
        numPages: ref(2),
        currentPage: ref(1),
        annotationTool: ref('none'),
        getIdentity: () => ({
            getEditorIdentity: () => 'editor-id',
            getEditorPendingKey: () => 'pending-editor-id',
        }),
        getMarkupSubtype: () => ({
            toolToMarkupSubtype: {},
            isSelectionMarkupTool: () => false,
            setEditorMarkupSubtypeOverride: () => {},
            resolveEditorMarkupSubtypeOverride: () => null,
            resolveEditorSubtypeFromPresentation: () => null,
            syncMarkupSubtypePresentationForEditors: () => {},
        }),
        getSync: () => ({
            pendingCommentEditorKeys: new Set<string>(),
            scheduleAnnotationCommentsSync: () => {},
            toEditorSummary: () => {
                throw new Error('not used in resolvePagePointTarget tests');
            },
        }),
        getToolManager: () => ({
            updateModeWithRetry: async () => null,
            maybeAutoResetAnnotationTool: () => {},
        }),
        stopDrag: () => {},
        emitAnnotationOpenNote: () => {},
        emitAnnotationNotePlacementChange: () => {},
    });
}

function createTarget(page: HTMLElement | null) {
    const target = document.createElement('div');
    page?.append(target);
    return target;
}

class FakePointerEvent extends Event {
    constructor(
        type: string,
        readonly init: PointerEventInit = {},
    ) {
        super(type);
    }
}

beforeEach(() => {
    document.body.replaceChildren();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('useAnnotationHighlight resolvePagePointTarget', () => {
    it('prefers geometry fallback when target page conflicts with pointer coordinates', () => {
        const page1 = createPageContainer(1, {
            left: 0,
            top: 0,
            width: 200,
            height: 200,
        });
        const page2 = createPageContainer(2, {
            left: 0,
            top: 400,
            width: 200,
            height: 200,
        });
        const viewer = createViewerContainer([
            page1,
            page2,
        ]);

        const highlight = createHighlightHarness(viewer);
        const resolved = highlight.resolvePagePointTarget(
            100,
            450,
            createTarget(page1),
        );

        expect(resolved?.pageNumber).toBe(2);
        expect(resolved?.pageContainer).toBe(page2);
    });

    it('falls back to coordinate-based page resolution when target is unavailable', () => {
        const page1 = createPageContainer(1, {
            left: 0,
            top: 0,
            width: 200,
            height: 200,
        });
        const page2 = createPageContainer(2, {
            left: 0,
            top: 400,
            width: 200,
            height: 200,
        });
        const viewer = createViewerContainer([
            page1,
            page2,
        ]);

        const highlight = createHighlightHarness(viewer);
        const resolved = highlight.resolvePagePointTarget(100, 450);

        expect(resolved?.pageNumber).toBe(2);
        expect(resolved?.pageContainer).toBe(page2);
    });

    it('ignores target elements from outside the active viewer container', () => {
        const page1 = createPageContainer(1, {
            left: 0,
            top: 0,
            width: 200,
            height: 200,
        });
        const externalPage = createPageContainer(99, {
            left: 0,
            top: 400,
            width: 200,
            height: 200,
        });
        const viewer = createViewerContainer([page1]);

        const highlight = createHighlightHarness(viewer);
        const resolved = highlight.resolvePagePointTarget(
            100,
            100,
            createTarget(externalPage),
        );

        expect(resolved?.pageNumber).toBe(1);
        expect(resolved?.pageContainer).toBe(page1);
    });
});

describe('useAnnotationHighlight commentAtPoint', () => {
    it('does not reuse an existing editor when a new sticky-note editor is not available yet', async () => {
        vi.stubGlobal('PointerEvent', FakePointerEvent);

        const page = createPageContainer(1, {
            left: 0,
            top: 0,
            width: 200,
            height: 200,
        });
        const viewer = createViewerContainer([page]);
        const layerDiv = document.createElement('div');

        const existingEditor = {
            id: 'existing-editor',
            parentPageIndex: 0,
            div: document.createElement('div'),
            x: 0.1,
            y: 0.1,
            width: 0.01,
            height: 0.01,
            comment: { text: 'Existing note' },
        };
        const uiManager = {
            getMode: vi.fn(() => 0),
            getEditors: vi.fn(() => new Set([existingEditor])),
            getLayer: vi.fn(() => ({
                div: layerDiv,
                createAndAddNewEditor: vi.fn(),
            })),
            waitForEditorsRendered: vi.fn(async () => undefined),
        };
        const pendingCommentEditorKeys = new Set<string>();
        const emitAnnotationOpenNote = vi.fn();

        const highlight = useAnnotationHighlight({
            viewerContainer: ref(viewer),
            annotationUiManager: shallowRef(uiManager as never),
            numPages: ref(1),
            currentPage: ref(1),
            annotationTool: ref('none'),
            getIdentity: () => ({
                getEditorIdentity: editor => String(editor.id),
                getEditorPendingKey: editor => `pending:${String(editor.id)}`,
            }),
            getMarkupSubtype: () => ({
                toolToMarkupSubtype: {},
                isSelectionMarkupTool: () => false,
                setEditorMarkupSubtypeOverride: () => {},
                resolveEditorMarkupSubtypeOverride: () => null,
                resolveEditorSubtypeFromPresentation: () => null,
                syncMarkupSubtypePresentationForEditors: () => {},
            }),
            getSync: () => ({
                pendingCommentEditorKeys,
                scheduleAnnotationCommentsSync: () => {},
                toEditorSummary: (editor, pageIndex, text) => ({
                    id: String(editor.id),
                    stableKey: `src:editor:${pageIndex}:${String(editor.id)}`,
                    pageIndex,
                    pageNumber: pageIndex + 1,
                    text,
                    author: null,
                    modifiedAt: null,
                    color: null,
                    uid: null,
                    annotationId: null,
                    source: 'editor',
                    hasNote: true,
                    markerRect: null,
                }),
            }),
            getToolManager: () => ({
                updateModeWithRetry: async () => null,
                maybeAutoResetAnnotationTool: () => {},
            }),
            stopDrag: () => {},
            emitAnnotationOpenNote,
            emitAnnotationNotePlacementChange: () => {},
        });

        const created = await highlight.commentAtPoint(1, 0.5, 0.5, { preferTextAnchor: false });

        expect(created).toBe(false);
        expect(emitAnnotationOpenNote).not.toHaveBeenCalled();
        expect(pendingCommentEditorKeys.has('pending:existing-editor')).toBe(false);
    });
});

describe('useAnnotationHighlight highlightSelectionInternal', () => {
    it('registers a created text markup editor with PDF.js undo history', async () => {
        vi.stubGlobal('PointerEvent', FakePointerEvent);

        const page = createPageContainer(1, {
            left: 0,
            top: 0,
            width: 200,
            height: 200,
        });
        const viewer = createViewerContainer([page]);
        const textLayer = document.createElement('div');
        textLayer.className = 'textLayer';
        const textSpan = document.createElement('span');
        textLayer.append(textSpan);
        page.append(textLayer);

        const textNode = document.createTextNode('Hello');
        textSpan.append(textNode);
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, 5);
        const selection: Partial<Selection> = {
            addRange: vi.fn(),
            removeAllRanges: vi.fn(),
        };
        vi.spyOn(document, 'getSelection').mockReturnValue(selection as Selection);

        const createdEditor = {
            id: 'created-editor',
            div: document.createElement('div'),
            parentPageIndex: 0,
        };
        const layer = {
            div: document.createElement('div'),
            addCommands: vi.fn(),
            addUndoableEditor: vi.fn(),
            createAndAddNewEditor: vi.fn(() => createdEditor),
        };
        const selectionBoxes = [{
            x: 0.1,
            y: 0.1,
            width: 0.2,
            height: 0.03,
        }];
        const uiManager = {
            getActive: vi.fn(() => null),
            getEditors: vi.fn(() => new Set()),
            getLayer: vi.fn(() => layer),
            getMode: vi.fn(() => 0),
            getSelectionBoxes: vi.fn(() => selectionBoxes),
            waitForEditorsRendered: vi.fn(async () => undefined),
        };

        const highlight = useAnnotationHighlight({
            viewerContainer: ref(viewer),
            annotationUiManager: shallowRef(uiManager as never),
            numPages: ref(1),
            currentPage: ref(1),
            annotationTool: ref('none'),
            getIdentity: () => ({
                getEditorIdentity: editor => String(editor.id),
                getEditorPendingKey: editor => `pending:${String(editor.id)}`,
            }),
            getMarkupSubtype: () => ({
                toolToMarkupSubtype: {},
                isSelectionMarkupTool: () => false,
                setEditorMarkupSubtypeOverride: () => {},
                resolveEditorMarkupSubtypeOverride: () => null,
                resolveEditorSubtypeFromPresentation: () => null,
                syncMarkupSubtypePresentationForEditors: () => {},
            }),
            getSync: () => ({
                pendingCommentEditorKeys: new Set<string>(),
                scheduleAnnotationCommentsSync: () => {},
                toEditorSummary: () => {
                    throw new Error('not used in highlight selection test');
                },
            }),
            getToolManager: () => ({
                updateModeWithRetry: async () => null,
                maybeAutoResetAnnotationTool: () => {},
            }),
            stopDrag: () => {},
            emitAnnotationOpenNote: () => {},
            emitAnnotationNotePlacementChange: () => {},
        });

        const created = await highlight.highlightSelectionInternal(false, range);

        expect(created).toBe(true);
        expect(layer.createAndAddNewEditor).toHaveBeenCalled();
        expect(layer.addCommands).toHaveBeenCalledTimes(1);
        expect(layer.addCommands).toHaveBeenCalledWith(expect.objectContaining({ mustExec: false }));
        expect(layer.addUndoableEditor).not.toHaveBeenCalled();
    });

});
