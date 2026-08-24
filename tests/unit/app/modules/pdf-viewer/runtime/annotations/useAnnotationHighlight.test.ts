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
import { useAnnotationHighlight } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationHighlight';
import {
    runInTrackedScope,
    stopTrackedScopes,
} from '@tests/helpers/trackedEffectScope';

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
    return runInTrackedScope(() => useAnnotationHighlight({
        viewerContainer: ref(viewerContainer),
        isActive: ref(true),
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
        }),
        getSync: () => ({
            scheduleAnnotationCommentsSync: () => {},
            toEditorSummary: () => {
                throw new Error('not used in resolvePagePointTarget tests');
            },
        }),
        getToolManager: () => ({
            updateModeWithRetry: async () => null,
            maybeAutoResetAnnotationTool: () => {},
        }),
        textMarkupPresentation: {notify: vi.fn()},
        annotationIntentSink: {
            submitSelectionMarkupIntent: () => {
                throw new Error('not used in resolvePagePointTarget tests');
            },
            submitStickyNoteIntent: () => {
                throw new Error('not used in resolvePagePointTarget tests');
            },
            bindProjectedEditorIdentity: () => {},
        },
        stopDrag: () => {},
        emitAnnotationOpenNote: () => {},
        emitAnnotationNotePlacementChange: () => {},
    }));
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
    stopTrackedScopes();
    vi.useRealTimers();
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
        const emitAnnotationOpenNote = vi.fn();
        const order: string[] = [];
        const canonicalComment = {
            appAnnotationId: 'canonical-note',
            id: 'canonical-note',
            stableKey: 'src:editor:0:canonical-note' as const,
            pageIndex: 0,
            pageNumber: 1,
            text: '',
            author: null,
            modifiedAt: null,
            color: null,
            uid: null,
            annotationId: null,
            source: 'editor' as const,
            hasNote: true,
            markerRect: {
                left: 0.4992,
                top: 0.4992,
                width: 0.0016,
                height: 0.0016,
            },
        };

        const highlight = useAnnotationHighlight({
            viewerContainer: ref(viewer),
            isActive: ref(true),
            annotationUiManager: shallowRef(uiManager as never),
            numPages: ref(1),
            currentPage: ref(1),
            annotationTool: ref('none'),
            getIdentity: () => ({getEditorIdentity: editor => String(editor.id)}),
            getMarkupSubtype: () => ({
                toolToMarkupSubtype: {},
                isSelectionMarkupTool: () => false,
                setEditorMarkupSubtypeOverride: () => {},
                resolveEditorMarkupSubtypeOverride: () => null,
                resolveEditorSubtypeFromPresentation: () => null,
            }),
            getSync: () => ({
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
                updateModeWithRetry: async () => {
                    order.push('pdfjs-mode');
                    return null;
                },
                maybeAutoResetAnnotationTool: () => {},
            }),
            textMarkupPresentation: {notify: vi.fn()},
            annotationIntentSink: {
                submitSelectionMarkupIntent: () => {
                    throw new Error('not used in point note test');
                },
                submitStickyNoteIntent: () => {
                    order.push('store-command');
                    return {
                        annotationId: 'canonical-note',
                        comment: canonicalComment,
                    };
                },
                bindProjectedEditorIdentity: () => {},
            },
            stopDrag: () => {},
            emitAnnotationOpenNote,
            emitAnnotationNotePlacementChange: () => {},
        });

        const outcome = await highlight.commentAtPoint(1, 0.5, 0.5, { preferTextAnchor: false });

        expect(outcome).toEqual({
            status: 'pending-editor',
            annotationId: 'canonical-note',
            reason: 'editor-unavailable',
        });
        expect(order[0]).toBe('store-command');
        expect(order[1]).toBe('pdfjs-mode');
        expect(emitAnnotationOpenNote).toHaveBeenCalledWith(canonicalComment);
    });
});

describe('useAnnotationHighlight highlightSelectionInternal', () => {
    it('keeps another viewer selection intact while clearing the owning viewer portal layer', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('PointerEvent', FakePointerEvent);
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => (
            window.setTimeout(() => callback(performance.now()), 16)
        ));
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(handle => window.clearTimeout(handle));

        const ownerHost = document.createElement('div');
        ownerHost.dataset.pdfViewerHost = '';
        const ownerPage = createPageContainer(1, {
            left: 0,
            top: 0,
            width: 200,
            height: 200,
        });
        const ownerViewer = createViewerContainer([ownerPage]);
        const ownerTextLayer = document.createElement('div');
        ownerTextLayer.className = 'textLayer';
        const ownerText = document.createTextNode('Owner text');
        ownerTextLayer.append(ownerText);
        ownerPage.append(ownerTextLayer);
        const ownerPortalLayer = document.createElement('div');
        ownerPortalLayer.className = 'annotationEditorLayer';
        const ownerSelectedEditor = document.createElement('div');
        ownerSelectedEditor.className = 'selectedEditor selected';
        ownerPortalLayer.append(ownerSelectedEditor);
        ownerHost.append(ownerViewer, ownerPortalLayer);

        const otherHost = document.createElement('div');
        otherHost.dataset.pdfViewerHost = '';
        const otherViewer = createViewerContainer([]);
        const otherPortalLayer = document.createElement('div');
        otherPortalLayer.className = 'annotationEditorLayer';
        const otherSelectedEditor = document.createElement('div');
        otherSelectedEditor.className = 'selectedEditor selected';
        const otherInput = document.createElement('input');
        const otherSelectionText = document.createTextNode('Other viewer text');
        const otherTextContainer = document.createElement('span');
        otherTextContainer.append(otherSelectionText);
        otherPortalLayer.append(otherSelectedEditor, otherInput, otherTextContainer);
        otherHost.append(otherViewer, otherPortalLayer);
        document.body.append(ownerHost, otherHost);

        const ownerRange = document.createRange();
        ownerRange.setStart(ownerText, 0);
        ownerRange.setEnd(ownerText, ownerText.length);
        const otherRange = document.createRange();
        otherRange.setStart(otherSelectionText, 0);
        otherRange.setEnd(otherSelectionText, otherSelectionText.length);
        const selection = document.getSelection();
        if (!selection) {
            throw new Error('Browser selection is unavailable');
        }

        const createdEditor = {
            id: 'created-editor',
            div: ownerSelectedEditor,
            parentPageIndex: 0,
        };
        const layer = {
            div: ownerPortalLayer,
            addCommands: vi.fn(),
            addUndoableEditor: vi.fn(),
            createAndAddNewEditor: vi.fn(() => {
                selection.removeAllRanges();
                selection.addRange(otherRange);
                otherInput.focus();
                return createdEditor;
            }),
        };
        const uiManager = {
            getActive: vi.fn(() => null),
            getEditors: vi.fn(() => new Set()),
            getLayer: vi.fn(() => layer),
            getMode: vi.fn(() => 0),
            getSelectionBoxes: vi.fn(() => [{
                x: 0.1,
                y: 0.1,
                width: 0.2,
                height: 0.03,
            }]),
            waitForEditorsRendered: vi.fn(async () => undefined),
        };

        const highlight = useAnnotationHighlight({
            viewerContainer: ref(ownerViewer),
            isActive: ref(true),
            annotationUiManager: shallowRef(uiManager as never),
            numPages: ref(1),
            currentPage: ref(1),
            annotationTool: ref('none'),
            getIdentity: () => ({getEditorIdentity: editor => String(editor.id)}),
            getMarkupSubtype: () => ({
                toolToMarkupSubtype: {},
                isSelectionMarkupTool: () => false,
                setEditorMarkupSubtypeOverride: () => {},
                resolveEditorMarkupSubtypeOverride: () => null,
                resolveEditorSubtypeFromPresentation: () => null,
            }),
            getSync: () => ({
                scheduleAnnotationCommentsSync: () => {},
                toEditorSummary: (_editor, pageIndex) => ({
                    id: 'created-editor',
                    stableKey: `src:editor:${pageIndex}:created-editor`,
                    pageIndex,
                    pageNumber: pageIndex + 1,
                    text: '',
                    author: null,
                    modifiedAt: null,
                    color: null,
                    uid: null,
                    annotationId: null,
                    source: 'editor',
                    hasNote: false,
                    markerRect: null,
                }),
            }),
            getToolManager: () => ({
                updateModeWithRetry: async () => null,
                maybeAutoResetAnnotationTool: () => {},
            }),
            textMarkupPresentation: {notify: vi.fn()},
            annotationIntentSink: {
                submitSelectionMarkupIntent: () => ({
                    annotationId: 'canonical-highlight',
                    subtype: 'Highlight',
                    comment: {
                        appAnnotationId: 'canonical-highlight',
                        id: 'canonical-highlight',
                        stableKey: 'src:editor:0:canonical-highlight',
                        pageIndex: 0,
                        pageNumber: 1,
                        text: '',
                        author: null,
                        modifiedAt: null,
                        color: null,
                        uid: null,
                        annotationId: null,
                        source: 'editor',
                        hasNote: false,
                        markerRect: null,
                    },
                    replacements: [],
                }),
                submitStickyNoteIntent: () => {
                    throw new Error('not used in highlight selection test');
                },
                bindProjectedEditorIdentity: () => {},
            },
            stopDrag: () => {},
            emitAnnotationOpenNote: () => {},
            emitAnnotationNotePlacementChange: () => {},
        });

        await expect(highlight.highlightSelectionInternal(false, ownerRange)).resolves.toEqual({
            status: 'created',
            annotationId: 'canonical-highlight',
        });

        expect(ownerSelectedEditor.classList.contains('selectedEditor')).toBe(false);
        expect(ownerSelectedEditor.classList.contains('selected')).toBe(false);
        expect(otherSelectedEditor.classList.contains('selectedEditor')).toBe(true);
        expect(otherSelectedEditor.classList.contains('selected')).toBe(true);
        expect(document.activeElement).toBe(otherInput);
        expect(selection.rangeCount).toBe(1);
        expect(selection.getRangeAt(0).toString()).toBe('Other viewer text');

        await vi.advanceTimersByTimeAsync(80);

        expect(otherSelectedEditor.classList.contains('selectedEditor')).toBe(true);
        expect(otherSelectedEditor.classList.contains('selected')).toBe(true);
        expect(document.activeElement).toBe(otherInput);
        expect(selection.rangeCount).toBe(1);
        expect(selection.getRangeAt(0).toString()).toBe('Other viewer text');
    });

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
            createAndAddNewEditor: vi.fn(() => {
                order.push('pdfjs-create');
                return createdEditor;
            }),
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
        const order: string[] = [];
        const bindEditorIdentity = vi.fn();

        const highlight = useAnnotationHighlight({
            viewerContainer: ref(viewer),
            isActive: ref(true),
            annotationUiManager: shallowRef(uiManager as never),
            numPages: ref(1),
            currentPage: ref(1),
            annotationTool: ref('none'),
            getIdentity: () => ({getEditorIdentity: editor => String(editor.id)}),
            getMarkupSubtype: () => ({
                toolToMarkupSubtype: {},
                isSelectionMarkupTool: () => false,
                setEditorMarkupSubtypeOverride: () => {},
                resolveEditorMarkupSubtypeOverride: () => null,
                resolveEditorSubtypeFromPresentation: () => null,
            }),
            getSync: () => ({
                scheduleAnnotationCommentsSync: () => {},
                toEditorSummary: (_editor, pageIndex) => ({
                    id: 'created-editor',
                    stableKey: `src:editor:${pageIndex}:created-editor`,
                    pageIndex,
                    pageNumber: pageIndex + 1,
                    text: '',
                    author: null,
                    modifiedAt: null,
                    color: null,
                    uid: null,
                    annotationId: null,
                    source: 'editor',
                    hasNote: false,
                    markerRect: null,
                }),
            }),
            getToolManager: () => ({
                updateModeWithRetry: async () => null,
                maybeAutoResetAnnotationTool: () => {},
            }),
            textMarkupPresentation: {notify: vi.fn()},
            annotationIntentSink: {
                submitSelectionMarkupIntent: () => {
                    order.push('store-command');
                    return {
                        annotationId: 'canonical-highlight',
                        subtype: 'Highlight',
                        comment: {
                            appAnnotationId: 'canonical-highlight',
                            id: 'canonical-highlight',
                            stableKey: 'src:editor:0:canonical-highlight',
                            pageIndex: 0,
                            pageNumber: 1,
                            text: '',
                            author: null,
                            modifiedAt: null,
                            color: null,
                            uid: null,
                            annotationId: null,
                            source: 'editor',
                            hasNote: false,
                            markerRect: null,
                        },
                        replacements: [],
                    };
                },
                submitStickyNoteIntent: () => {
                    throw new Error('not used in highlight selection test');
                },
                bindProjectedEditorIdentity: bindEditorIdentity,
            },
            stopDrag: () => {},
            emitAnnotationOpenNote: () => {},
            emitAnnotationNotePlacementChange: () => {},
        });

        const outcome = await highlight.highlightSelectionInternal(false, range);

        expect(outcome).toEqual({
            status: 'created',
            annotationId: 'canonical-highlight',
        });
        expect(order).toEqual([
            'store-command',
            'pdfjs-create',
        ]);
        expect(bindEditorIdentity).toHaveBeenCalledWith(
            'canonical-highlight',
            expect.objectContaining({id: 'created-editor'}),
        );
        expect(layer.createAndAddNewEditor).toHaveBeenCalled();
        expect(layer.addCommands).toHaveBeenCalledTimes(1);
        expect(layer.addCommands).toHaveBeenCalledWith(expect.objectContaining({ mustExec: false }));
        expect(layer.addUndoableEditor).not.toHaveBeenCalled();
    });

});
