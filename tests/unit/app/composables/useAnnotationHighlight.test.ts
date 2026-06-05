import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import { useAnnotationHighlight } from '@app/composables/pdf/annotations/useAnnotationHighlight';

vi.mock('pdfjs-dist', () => ({AnnotationEditorType: {FREETEXT: 3}}));

interface IRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface IFakePageElement {
    dataset: { page?: string };
    getBoundingClientRect: () => {
        left: number;
        top: number;
        width: number;
        height: number;
        right: number;
        bottom: number;
        x: number;
        y: number;
        toJSON: () => object;
    };
}

interface IFakeViewerContainer {
    querySelectorAll: (selector: string) => IFakePageElement[];
    contains: (target: IFakePageElement | null) => boolean;
}

interface IFakeTargetElement {closest: (selector: string) => IFakePageElement | null;}

function asElement(value: object) {
    return value as HTMLElement;
}

function asNode(value: object): Node {
    return value as Node;
}

function createFakePageContainer(page: number, rect: IRect): IFakePageElement {
    return {
        dataset: { page: String(page) },
        getBoundingClientRect: () => ({
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
    };
}

function createFakeViewerContainer(pages: IFakePageElement[]): IFakeViewerContainer {
    return {
        querySelectorAll: (selector: string) => selector === '.page_container' ? pages : [],
        contains: (target: IFakePageElement | null) => Boolean(
            target && pages.some(page => page === target || page.dataset.page === target.dataset.page),
        ),
    };
}

function createHighlightHarness(viewerContainer: IFakeViewerContainer) {
    return useAnnotationHighlight({
        viewerContainer: ref(asElement(viewerContainer)),
        annotationUiManager: shallowRef(null),
        numPages: ref(2),
        currentPage: ref(1),
        annotationTool: ref('none'),
        getIdentity: () => ({
            getEditorIdentity: () => 'editor-id',
            getEditorPendingKey: () => 'pending-editor-id',
        }),
        getMarkupSubtype: () => ({
            TOOL_TO_MARKUP_SUBTYPE: {},
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

function createTarget(page: IFakePageElement | null): IFakeTargetElement {
    return {closest: (selector: string) => selector === '.page_container' ? page : null};
}

function createDomPageContainer(page: number, rect: IRect) {
    const element = new FakeHTMLElement();
    element.className = 'page_container';
    element.dataset.page = String(page);
    element.rect = rect;
    return element;
}

class FakeHTMLElement {
    className = '';
    dataset: { page?: string } = {};
    tagName = 'div';
    rect: IRect = {
        left: 0,
        top: 0,
        width: 0,
        height: 0,
    };
    children: FakeHTMLElement[] = [];
    parentElement: FakeHTMLElement | null = null;
    classList = {remove: (..._classNames: string[]) => {}};

    append(child: FakeHTMLElement) {
        child.parentElement = this;
        this.children.push(child);
    }

    contains(target: FakeHTMLElement | null): boolean {
        return target === this || Boolean(target && this.children.some(child => child.contains(target)));
    }

    closest(selector: string): FakeHTMLElement | null {
        if (
            selector === '.text-layer, .textLayer'
            && (
                this.className.split(/\s+/).includes('text-layer')
                || this.className.split(/\s+/).includes('textLayer')
            )
        ) {
            return this;
        }
        if (
            selector === '.page_container'
            && this.className.split(/\s+/).includes('page_container')
        ) {
            return this;
        }
        return this.parentElement?.closest(selector) ?? null;
    }

    querySelector(selector: string) {
        if (selector === `.page_container[data-page="${this.dataset.page}"]`) {
            return this;
        }
        return this.children.find(child => selector === `.page_container[data-page="${child.dataset.page}"]`) ?? null;
    }

    querySelectorAll(selector: string) {
        if (selector !== '.page_container') {
            return [];
        }
        return [
            ...(this.className === 'page_container' ? [this] : []),
            ...this.children.filter(child => child.className === 'page_container'),
        ];
    }

    dispatchEvent(_event: Event) {
        return true;
    }

    blur() {}

    getBoundingClientRect() {
        const rect = this.rect;
        return {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            right: rect.left + rect.width,
            bottom: rect.top + rect.height,
            x: rect.left,
            y: rect.top,
            toJSON: () => ({}),
        };
    }

    getAttributeNames() {
        return [];
    }
}

class FakePointerEvent {
    constructor(
        readonly type: string,
        readonly init: PointerEventInit = {},
    ) {}
}

describe('useAnnotationHighlight resolvePagePointTarget', () => {
    it('prefers geometry fallback when target page conflicts with pointer coordinates', () => {
        const page1 = createFakePageContainer(1, {
            left: 0,
            top: 0,
            width: 200,
            height: 200,
        });
        const page2 = createFakePageContainer(2, {
            left: 0,
            top: 400,
            width: 200,
            height: 200,
        });
        const viewer = createFakeViewerContainer([
            page1,
            page2,
        ]);

        const highlight = createHighlightHarness(viewer);
        const resolved = highlight.resolvePagePointTarget(
            100,
            450,
            asElement(createTarget(page1)),
        );

        expect(resolved?.pageNumber).toBe(2);
        expect(resolved?.pageContainer).toBe(page2);
    });

    it('falls back to coordinate-based page resolution when target is unavailable', () => {
        const page1 = createFakePageContainer(1, {
            left: 0,
            top: 0,
            width: 200,
            height: 200,
        });
        const page2 = createFakePageContainer(2, {
            left: 0,
            top: 400,
            width: 200,
            height: 200,
        });
        const viewer = createFakeViewerContainer([
            page1,
            page2,
        ]);

        const highlight = createHighlightHarness(viewer);
        const resolved = highlight.resolvePagePointTarget(100, 450);

        expect(resolved?.pageNumber).toBe(2);
        expect(resolved?.pageContainer).toBe(page2);
    });

    it('ignores target elements from outside the active viewer container', () => {
        const page1 = createFakePageContainer(1, {
            left: 0,
            top: 0,
            width: 200,
            height: 200,
        });
        const externalPage = createFakePageContainer(99, {
            left: 0,
            top: 400,
            width: 200,
            height: 200,
        });
        const viewer = createFakeViewerContainer([page1]);

        const highlight = createHighlightHarness(viewer);
        const resolved = highlight.resolvePagePointTarget(
            100,
            100,
            asElement(createTarget(externalPage)),
        );

        expect(resolved?.pageNumber).toBe(1);
        expect(resolved?.pageContainer).toBe(page1);
    });
});

describe('useAnnotationHighlight commentAtPoint', () => {
    it('does not reuse an existing editor when a new sticky-note editor is not available yet', async () => {
        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('PointerEvent', FakePointerEvent);

        const viewer = new FakeHTMLElement();
        const page = createDomPageContainer(1, {
            left: 0,
            top: 0,
            width: 200,
            height: 200,
        });
        const layerDiv = new FakeHTMLElement();
        viewer.append(page);

        const existingEditor = {
            id: 'existing-editor',
            parentPageIndex: 0,
            div: new FakeHTMLElement(),
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
            viewerContainer: ref(asElement(viewer)),
            annotationUiManager: shallowRef(uiManager as never),
            numPages: ref(1),
            currentPage: ref(1),
            annotationTool: ref('none'),
            getIdentity: () => ({
                getEditorIdentity: editor => String(editor.id),
                getEditorPendingKey: editor => `pending:${String(editor.id)}`,
            }),
            getMarkupSubtype: () => ({
                TOOL_TO_MARKUP_SUBTYPE: {},
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
        const originalDocument = Reflect.get(globalThis, 'document');
        const originalNode = Reflect.get(globalThis, 'Node');

        vi.stubGlobal('HTMLElement', FakeHTMLElement);
        vi.stubGlobal('PointerEvent', FakePointerEvent);
        Reflect.set(globalThis, 'Node', { TEXT_NODE: 3 });

        const viewer = new FakeHTMLElement();
        const page = createDomPageContainer(1, {
            left: 0,
            top: 0,
            width: 200,
            height: 200,
        });
        const textLayer = new FakeHTMLElement();
        textLayer.className = 'textLayer';
        const textSpan = new FakeHTMLElement();
        textLayer.append(textSpan);
        page.append(textLayer);
        viewer.append(page);

        const textNode = {
            nodeType: 3,
            parentElement: textSpan,
        };
        const range = {
            cloneRange: () => range,
            commonAncestorContainer: asNode(textNode),
            endContainer: asNode(textNode),
            endOffset: 5,
            startContainer: asNode(textNode),
            startOffset: 0,
            toString: () => 'Hello',
        } as Range;
        const selection = {
            addRange: vi.fn(),
            removeAllRanges: vi.fn(),
        };
        Reflect.set(globalThis, 'document', {
            activeElement: null,
            getSelection: () => selection,
            querySelectorAll: () => [],
        });

        try {
            const createdEditor = {
                id: 'created-editor',
                div: asElement(new FakeHTMLElement()),
                parentPageIndex: 0,
            };
            const layer = {
                div: asElement(new FakeHTMLElement()),
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
                viewerContainer: ref(asElement(viewer)),
                annotationUiManager: shallowRef(uiManager as never),
                numPages: ref(1),
                currentPage: ref(1),
                annotationTool: ref('none'),
                getIdentity: () => ({
                    getEditorIdentity: editor => String(editor.id),
                    getEditorPendingKey: editor => `pending:${String(editor.id)}`,
                }),
                getMarkupSubtype: () => ({
                    TOOL_TO_MARKUP_SUBTYPE: {},
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
        } finally {
            if (originalDocument === undefined) {
                Reflect.deleteProperty(globalThis, 'document');
            } else {
                Reflect.set(globalThis, 'document', originalDocument);
            }
            if (originalNode === undefined) {
                Reflect.deleteProperty(globalThis, 'Node');
            } else {
                Reflect.set(globalThis, 'Node', originalNode);
            }
        }
    });

});
