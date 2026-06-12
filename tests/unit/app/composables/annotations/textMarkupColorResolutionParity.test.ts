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
import { resolveAnnotationCommentTextMarkupColor } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/resolveAnnotationCommentTextMarkupColor';
import { sampleCanvasTextMarkupColorAtPoint } from '@app/modules/pdf-viewer/engine/annotations/annotation-text-markup-canvas-pixels/sampleCanvasTextMarkupColorAtPoint';
import { sampleCanvasTextMarkupColorInRect } from '@app/modules/pdf-viewer/engine/annotations/annotation-text-markup-canvas-pixels/sampleCanvasTextMarkupColorInRect';

const canvasMocks = vi.hoisted(() => ({
    atPoint: vi.fn(),
    inRect: vi.fn(),
}));

vi.mock('@app/modules/pdf-viewer/engine/annotations/annotation-text-markup-canvas-pixels/sampleCanvasTextMarkupColorAtPoint', () => ({sampleCanvasTextMarkupColorAtPoint: canvasMocks.atPoint}));

vi.mock('@app/modules/pdf-viewer/engine/annotations/annotation-text-markup-canvas-pixels/sampleCanvasTextMarkupColorInRect', () => ({sampleCanvasTextMarkupColorInRect: canvasMocks.inRect}));

interface ITestRect {
    height: number;
    left: number;
    top: number;
    width: number;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function withRect<T extends Element>(element: T, rect: ITestRect) {
    Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            bottom: rect.top + rect.height,
            height: rect.height,
            left: rect.left,
            right: rect.left + rect.width,
            toJSON: () => ({}),
            top: rect.top,
            width: rect.width,
            x: rect.left,
            y: rect.top,
        }),
    });
    return element;
}

function createElement(className: string, rect: ITestRect): HTMLElement;
function createElement(className: string, rect: ITestRect, tagName: 'canvas'): HTMLCanvasElement;
function createElement(className: string, rect: ITestRect, tagName: 'div'): HTMLDivElement;
function createElement(className: string, rect: ITestRect, tagName: 'svg'): SVGSVGElement;
function createElement(
    className: string,
    rect: ITestRect,
    tagName: 'div' | 'svg' | 'canvas' = 'div',
): HTMLElement | SVGSVGElement {
    const element = tagName === 'svg'
        ? document.createElementNS(SVG_NAMESPACE, 'svg')
        : document.createElement(tagName);
    element.setAttribute('class', className);
    return withRect(element, rect);
}

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        annotationId: overrides.annotationId ?? '42R0',
        author: null,
        color: null,
        hasNote: false,
        id: overrides.id ?? 'comment-1',
        kindLabel: null,
        markerRect: overrides.markerRect ?? {
            height: 0.05,
            left: 0.1,
            top: 0.2,
            width: 0.2,
        },
        modifiedAt: null,
        pageIndex: 0,
        pageNumber: 1,
        sortIndex: null,
        source: 'pdf',
        stableKey: overrides.stableKey ?? 'ann:0:42R',
        subtype: overrides.subtype ?? 'Highlight',
        text: 'Marked text',
        uid: null,
        ...overrides,
    };
}

function createViewerFixture() {
    const container = createElement('viewer', {
        height: 1000,
        left: 0,
        top: 0,
        width: 1000,
    });
    const page = createElement('page_container', {
        height: 1000,
        left: 0,
        top: 0,
        width: 1000,
    });
    page.dataset.page = '1';
    container.append(page);
    document.body.append(container);
    return {
        container,
        page,
    };
}

function resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    clientX: number,
    clientY: number,
) {
    return resolveAnnotationCommentTextMarkupColor(
        container,
        comment,
        {atPoint: {
            pageX: clientX,
            pageY: clientY,
        }},
    );
}

beforeEach(() => {
    document.body.replaceChildren();
    canvasMocks.atPoint.mockReset();
    canvasMocks.inRect.mockReset();
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
    document.body.replaceChildren();
});

describe('text markup color resolution parity', () => {
    it('resolves a matching annotation element color in both resolver paths', () => {
        const {
            container,
            page,
        } = createViewerFixture();
        const element = createElement('highlight textLayerHighlight', {
            height: 50,
            left: 100,
            top: 200,
            width: 200,
        });
        element.dataset.annotationId = '42R0';
        element.style.backgroundColor = 'rgb(17, 34, 51)';
        page.append(element);
        vi.spyOn(document, 'elementsFromPoint').mockReturnValue([element]);
        vi.spyOn(document, 'elementFromPoint').mockReturnValue(element);

        const plainColor = resolveAnnotationCommentTextMarkupColor(container, createComment());
        const diagnostics = resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
            container,
            createComment(),
            200,
            225,
        );

        expect(plainColor).toBe('#112233');
        expect(diagnostics).toMatchObject({
            color: plainColor,
            pointElementCount: 1,
            source: 'point:element',
            subtype: 'highlight',
        });
    });

    it('uses geometry-matched text-markup elements when ids are unavailable', () => {
        const {
            container,
            page,
        } = createViewerFixture();
        const element = createElement('highlight textLayerHighlight', {
            height: 50,
            left: 100,
            top: 200,
            width: 200,
        });
        element.dataset.annotationId = '77R0';
        element.style.setProperty('--pdf-markup-subtype-color', 'rgb(34, 197, 94)');
        page.append(element);

        const color = resolveAnnotationCommentTextMarkupColor(
            container,
            createComment({ annotationId: null }),
        );

        expect(color).toBe('#22c55e');
    });

    it('keeps canvas fallback exclusive to the point diagnostics resolver', () => {
        const {
            container,
            page,
        } = createViewerFixture();
        const canvas = createElement('page-canvas', {
            height: 1000,
            left: 0,
            top: 0,
            width: 1000,
        }, 'canvas');
        page.append(canvas);
        canvasMocks.inRect.mockReturnValue('#abcdef');

        const plainColor = resolveAnnotationCommentTextMarkupColor(container, createComment());
        const diagnostics = resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
            container,
            createComment(),
            200,
            225,
        );

        expect(plainColor).toBeNull();
        expect(sampleCanvasTextMarkupColorInRect).toHaveBeenCalledWith(
            canvas,
            page,
            {
                height: 0.05,
                left: 0.1,
                top: 0.2,
                width: 0.2,
            },
        );
        expect(sampleCanvasTextMarkupColorAtPoint).not.toHaveBeenCalled();
        expect(diagnostics).toMatchObject({
            color: '#abcdef',
            element: 'canvas',
            pointElementCount: 0,
            source: 'canvas',
        });
    });

    it('falls back to point canvas sampling after DOM and geometry miss', () => {
        const {
            container,
            page,
        } = createViewerFixture();
        const canvas = createElement('page-canvas', {
            height: 1000,
            left: 0,
            top: 0,
            width: 1000,
        }, 'canvas');
        page.append(canvas);
        canvasMocks.inRect.mockReturnValue(null);
        canvasMocks.atPoint.mockReturnValue('#fedcba');

        const diagnostics = resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
            container,
            createComment(),
            200,
            225,
        );

        expect(sampleCanvasTextMarkupColorAtPoint).toHaveBeenCalledWith(canvas, 200, 225);
        expect(diagnostics).toMatchObject({
            color: '#fedcba',
            element: 'canvas',
            pointElementCount: 0,
            source: 'canvas',
        });
    });
});
