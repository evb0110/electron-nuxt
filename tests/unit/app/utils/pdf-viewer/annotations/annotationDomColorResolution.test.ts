// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { resolveAnnotationCommentTextMarkupColor } from '@app/utils/pdf-viewer/annotations/annotation-dom-removal/resolveAnnotationCommentTextMarkupColor';
import { resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics } from '@app/utils/pdf-viewer/annotations/annotation-dom-removal/resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics';

interface IRect {
    height: number;
    left: number;
    top: number;
    width: number;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function withRect<T extends Element>(
    element: T,
    rect: IRect,
) {
    Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            ...rect,
            bottom: rect.top + rect.height,
            right: rect.left + rect.width,
            x: rect.left,
            y: rect.top,
            toJSON: () => ({}),
        }),
    });
    return element;
}

function createElement(
    className: string,
    rect: IRect,
): HTMLElement;
function createElement(
    className: string,
    rect: IRect,
    tagName: 'svg' | 'path',
): SVGElement;
function createElement(
    className: string,
    rect: IRect,
    tagName: 'div' | 'svg' | 'path' = 'div',
): HTMLElement | SVGElement {
    const element = tagName === 'svg' || tagName === 'path'
        ? document.createElementNS(SVG_NAMESPACE, tagName)
        : document.createElement(tagName);
    element.setAttribute('class', className);
    return withRect(element, rect);
}

function createComment(overrides: Partial<IAnnotationCommentSummary>): IAnnotationCommentSummary {
    return {
        id: 'comment-1',
        stableKey: 'comment-1',
        pageIndex: 0,
        pageNumber: 1,
        text: 'Marked text',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: null,
        source: 'pdf',
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.2,
            height: 0.05,
        },
        ...overrides,
    };
}

function createViewerFixture() {
    const container = createElement('viewer', {
        left: 0,
        top: 0,
        width: 1000,
        height: 1000,
    });
    const page = createElement('page_container', {
        left: 0,
        top: 0,
        width: 1000,
        height: 1000,
    });
    page.dataset.page = '1';
    container.append(page);
    document.body.append(container);
    return {
        container,
        ownerDocument: document,
        page,
    };
}

beforeEach(() => {
    document.body.replaceChildren();
    Object.defineProperty(document, 'elementsFromPoint', {
        configurable: true,
        value: vi.fn(() => []),
    });
    Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: vi.fn(() => null),
    });
    vi.spyOn(globalThis, 'getComputedStyle')
        .mockImplementation((element: Element) => (
            element instanceof HTMLElement || element instanceof SVGElement
                ? element.style
                : document.documentElement.style
        ));
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('annotation text markup color resolution', () => {
    it('uses geometry-matched annotation elements when the PDF summary has no annotation id', () => {
        const {
            container,
            page,
        } = createViewerFixture();
        const renderedHighlight = createElement('highlight textLayerHighlight', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        renderedHighlight.dataset.annotationId = '77R0';
        renderedHighlight.style.setProperty('--pdf-markup-subtype-color', 'rgb(34, 197, 94)');
        page.append(renderedHighlight);

        const color = resolveAnnotationCommentTextMarkupColor(
            container,
            createComment({ subtype: 'Highlight' }),
        );

        expect(color).toBe('#22c55e');
    });

    it('reports point visual-node diagnostics for rendered highlight paint inside an editor shell', () => {
        const {
            container,
            ownerDocument,
            page,
        } = createViewerFixture();
        const editor = createElement('highlightEditor', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        editor.dataset.annotationId = '42R0';
        const paintedPath = createElement('', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        }, 'path');
        paintedPath.setAttribute('fill', '#bad3fc');
        editor.append(paintedPath);
        page.append(editor);
        vi.spyOn(ownerDocument, 'elementsFromPoint').mockReturnValue([editor]);
        vi.spyOn(ownerDocument, 'elementFromPoint').mockReturnValue(editor);

        const diagnostics = resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
            container,
            createComment({
                annotationId: '42R0',
                subtype: 'Highlight',
            }),
            200,
            225,
        );

        expect(diagnostics).toMatchObject({
            annotationId: '42R0',
            color: '#bad3fc',
            pointElementCount: 1,
            source: 'point:visual-node',
            subtype: 'highlight',
        });
    });

    it('prefers the visible nearby underline stroke over a stale editor dataset color', () => {
        const {
            container,
            ownerDocument,
            page,
        } = createViewerFixture();
        const staleEditor = createElement('highlightEditor pdf-markup-subtype-underline', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        staleEditor.dataset.annotationId = '88R0';
        staleEditor.dataset.markupSubtypeColor = '#22c55e';
        staleEditor.style.setProperty('--pdf-markup-subtype-color', '#22c55e');
        const visibleUnderline = createElement(
            'pdf-markup-subtype-draw-visual pdf-markup-subtype-draw-underline',
            {
                left: 100,
                top: 222,
                width: 200,
                height: 4,
            },
            'svg',
        );
        visibleUnderline.setAttribute('stroke', '#ef4444');
        page.append(staleEditor);
        page.append(visibleUnderline);
        vi.spyOn(ownerDocument, 'elementsFromPoint').mockReturnValue([staleEditor]);
        vi.spyOn(ownerDocument, 'elementFromPoint').mockReturnValue(staleEditor);

        const diagnostics = resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
            container,
            createComment({
                annotationId: '88R0',
                color: '#22c55e',
                subtype: 'Underline',
            }),
            200,
            224,
        );

        expect(diagnostics).toMatchObject({
            color: '#ef4444',
            source: 'point:nearby-element',
            subtype: 'underline',
        });
    });
});
