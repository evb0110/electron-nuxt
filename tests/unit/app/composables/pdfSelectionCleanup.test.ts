import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { clearPdfSelectionForLayerTeardown } from '@app/utils/pdf-viewer/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';

type TFakeNode = Node & {
    nodeType: number;
    parentElement: TFakeElement | null;
    isConnected: boolean;
};

type TFakeElement = HTMLElement & TFakeNode & {
    classNames: Set<string>;
    fakeChildren: TFakeNode[];
    contains: (node: Node) => boolean;
    closest: (selector: string) => TFakeElement | null;
};

function createElement(
    classNames: string[] = [],
    parentElement: TFakeElement | null = null,
) {
    const element = Object.assign(Object.create(null) as TFakeElement, {
        nodeType: 1,
        parentElement,
        isConnected: parentElement?.isConnected ?? true,
        classNames: new Set(classNames),
        fakeChildren: [],
        contains(node: Node) {
            let current: Node | null = node;
            while (current) {
                if (current === element) {
                    return true;
                }
                current = current.parentElement;
            }
            return false;
        },
        closest(selector: string) {
            let current: TFakeElement | null = element;
            while (current) {
                if (
                    selector === '.text-layer, .textLayer'
                    && (
                        current.classNames.has('text-layer')
                        || current.classNames.has('textLayer')
                    )
                ) {
                    return current;
                }
                current = current.parentElement;
            }
            return null;
        },
    });
    parentElement?.fakeChildren.push(element);
    return element;
}

function createText(parentElement: TFakeElement, isConnected = parentElement.isConnected) {
    const text = {
        nodeType: 3,
        parentElement,
        isConnected,
    } as TFakeNode;
    parentElement.fakeChildren.push(text);
    return text;
}

function stubSelection(selection: Partial<Selection> | null) {
    vi.stubGlobal('document', { getSelection: () => selection });
}

function createSelection(node: TFakeNode, overrides: Partial<Selection> = {}) {
    const range = {
        commonAncestorContainer: node,
        startContainer: node,
        endContainer: node,
    } as Range;
    return {
        anchorNode: node,
        focusNode: node,
        rangeCount: 1,
        isCollapsed: false,
        getRangeAt: vi.fn(() => range),
        removeAllRanges: vi.fn(),
        ...overrides,
    } as Selection;
}

describe('clearPdfSelectionForLayerTeardown', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('clears a selection inside the torn-down page container', () => {
        const page = createElement(['page_container']);
        const textLayer = createElement(['text-layer'], page);
        const text = createText(textLayer);
        const selection = createSelection(text);
        stubSelection(selection);

        const cleared = clearPdfSelectionForLayerTeardown({ target: page });

        expect(cleared).toBe(true);
        expect(selection.removeAllRanges).toHaveBeenCalledTimes(1);
    });

    it('leaves unrelated connected selections alone', () => {
        const page = createElement(['page_container']);
        const sidebar = createElement(['sidebar']);
        const text = createText(sidebar);
        const selection = createSelection(text);
        stubSelection(selection);

        const cleared = clearPdfSelectionForLayerTeardown({ target: page });

        expect(cleared).toBe(false);
        expect(selection.removeAllRanges).not.toHaveBeenCalled();
    });

    it('clears a detached selection endpoint after virtualization removes its page', () => {
        const page = createElement(['page_container']);
        const textLayer = createElement(['textLayer'], page);
        const text = createText(textLayer, false);
        const selection = createSelection(text);
        stubSelection(selection);

        const cleared = clearPdfSelectionForLayerTeardown({ includeDetached: true });

        expect(cleared).toBe(true);
        expect(selection.removeAllRanges).toHaveBeenCalledTimes(1);
    });

    it('can clear any PDF text selection inside the viewer root', () => {
        const root = createElement(['pdfViewer']);
        const page = createElement(['page_container'], root);
        const textLayer = createElement(['textLayer'], page);
        const text = createText(textLayer);
        const selection = createSelection(text);
        stubSelection(selection);

        const cleared = clearPdfSelectionForLayerTeardown({
            root,
            includeAnyPdfTextSelection: true,
        });

        expect(cleared).toBe(true);
        expect(selection.removeAllRanges).toHaveBeenCalledTimes(1);
    });
});
