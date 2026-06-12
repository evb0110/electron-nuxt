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
import { applyAnnotationCommentTextMarkupColor } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/applyAnnotationCommentTextMarkupColor';
import { applyAnnotationCommentTextMarkupVisualOverlay } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/applyAnnotationCommentTextMarkupVisualOverlay';
import { drawEditedTextMarkupCanvasVisual } from '@app/modules/pdf-viewer/engine/annotations/annotation-edited-text-markup-canvas/drawEditedTextMarkupCanvasVisual';
import { removeAnnotationCommentDom } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/removeAnnotationCommentDom';
import { resolveAnnotationCommentTextMarkupColor } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/resolveAnnotationCommentTextMarkupColor';
import { resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics';
import { resolveCommentWithRenderedTextMarkupColorAtPoint } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/resolveCommentWithRenderedTextMarkupColorAtPoint';
import { refreshHighlightCompositeOverlay } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/refreshHighlightCompositeOverlay';

vi.mock('@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/refreshHighlightCompositeOverlay', () => ({ refreshHighlightCompositeOverlay: vi.fn() }));

interface IAnnotationDomRemovalTestRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const svgTags = new Set([
    'g',
    'line',
    'mask',
    'path',
    'polygon',
    'polyline',
    'rect',
    'svg',
    'use',
]);

interface ITestCanvas extends HTMLCanvasElement { putImageDataCalls: number; }

function createDomRect(rect: IAnnotationDomRemovalTestRect): DOMRect {
    const {
        left,
        top,
        width,
        height,
    } = rect;
    return {
        bottom: top + height,
        height,
        left,
        right: left + width,
        toJSON: () => ({
            bottom: top + height,
            height,
            left,
            right: left + width,
            top,
            width,
            x: left,
            y: top,
        }),
        top,
        width,
        x: left,
        y: top,
    };
}

function setTestRect<T extends Element>(element: T, rect: IAnnotationDomRemovalTestRect) {
    Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => createDomRect(rect),
    });
    return element;
}

function createTestElement(tagOrClassName: string, rect: IAnnotationDomRemovalTestRect): HTMLElement {
    const normalized = tagOrClassName.trim();
    const tagName = normalized.split(/\s+/u)[0] ?? 'div';
    const element = (
        tagName === 'highlight'
        || normalized.includes('pdf-markup-subtype-draw-visual')
        || svgTags.has(normalized)
            ? document.createElementNS(SVG_NAMESPACE, svgTags.has(normalized) ? normalized : 'svg')
            : document.createElement(tagName === 'mark' || tagName === 'u' || tagName === 's' || tagName === 'canvas' ? tagName : 'div')
    );

    if (!svgTags.has(normalized) && tagName !== 'mark' && tagName !== 'u' && tagName !== 's' && tagName !== 'canvas') {
        element.setAttribute('class', normalized);
    }
    if (tagName === 'highlight' || normalized.includes('pdf-markup-subtype-draw-visual')) {
        element.setAttribute('class', normalized);
    }

    return setTestRect(element, rect) as HTMLElement;
}

function createTestCanvas(rect: IAnnotationDomRemovalTestRect, pixelData: Uint8ClampedArray) {
    const canvas = createTestElement('canvas', rect) as ITestCanvas;
    canvas.width = rect.width;
    canvas.height = rect.height;
    canvas.putImageDataCalls = 0;
    const getContext = vi.fn((type: string) => {
        if (type !== '2d') {
            return null;
        }
        return {
            getImageData: vi.fn(() => ({
                data: pixelData,
                height: canvas.height,
                width: canvas.width,
            })),
            putImageData: vi.fn(() => {
                canvas.putImageDataCalls += 1;
            }),
        };
    }) as HTMLCanvasElement['getContext'];
    canvas.getContext = getContext;
    return canvas;
}

function toHTMLElement(element: Element): HTMLElement {
    return element as HTMLElement;
}

const originalGetComputedStyle = globalThis.getComputedStyle;
const originalElementFromPoint = document.elementFromPoint.bind(document);

beforeEach(() => {
    document.body.replaceChildren();
    globalThis.getComputedStyle = originalGetComputedStyle;
    document.elementFromPoint = originalElementFromPoint;
    Reflect.deleteProperty(document, 'elementsFromPoint');
});

afterEach(() => {
    globalThis.getComputedStyle = originalGetComputedStyle;
    document.elementFromPoint = originalElementFromPoint;
    Reflect.deleteProperty(document, 'elementsFromPoint');
    document.body.replaceChildren();
});

function installInlineComputedStyle() {
    globalThis.getComputedStyle = ((element: Element) => (
        'style' in element
            ? element.style
            : originalGetComputedStyle(element)
    )) as typeof getComputedStyle;
}

function installPointElements(elements: Element[]) {
    Object.defineProperty(document, 'elementsFromPoint', {
        configurable: true,
        value: vi.fn(() => elements),
    });
    document.elementFromPoint = vi.fn(() => elements[0] ?? null);
}

function connectPage(container: HTMLElement, page: HTMLElement) {
    page.dataset.page = '1';
    container.append(page);
    document.body.append(container);
}

function connectToPage(page: HTMLElement, element: Element) {
    page.append(element);
}

function appendDrawVisuals(page: HTMLElement, ...visuals: Element[]) {
    const host = document.createElement('div');
    host.classList.add('page_canvas', 'canvasWrapper');
    page.append(host);
    host.append(...visuals);
}

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: overrides.id ?? '12R0',
        stableKey: overrides.stableKey ?? 'ann:0:12R',
        sortIndex: overrides.sortIndex ?? null,
        pageIndex: overrides.pageIndex ?? 0,
        pageNumber: overrides.pageNumber ?? 1,
        text: overrides.text ?? '',
        kindLabel: overrides.kindLabel ?? null,
        subtype: overrides.subtype ?? 'Highlight',
        author: overrides.author ?? null,
        modifiedAt: overrides.modifiedAt ?? null,
        color: overrides.color ?? null,
        uid: overrides.uid ?? null,
        annotationId: 'annotationId' in overrides ? (overrides.annotationId ?? null) : '12R0',
        source: overrides.source ?? 'pdf',
        hasNote: overrides.hasNote ?? false,
        markerRect: overrides.markerRect ?? {
            left: 0.1,
            top: 0.2,
            width: 0.2,
            height: 0.05,
        },
    };
}

describe('removeAnnotationCommentDom', () => {
    it('removes annotation layer elements using normalized PDF.js annotation ids', () => {
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const annotation = createTestElement('highlightAnnotation', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        annotation.dataset.annotationId = '12R';
        const popup = createTestElement('popup', {
            left: 120,
            top: 220,
            width: 20,
            height: 20,
        });
        popup.dataset.annotationId = 'popup-12R';
        popup.setAttribute('aria-controls', 'pdfjs_internal_id_12R');
        const annotationLayer = createTestElement('annotationLayer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        container.append(annotationLayer);
        annotationLayer.append(annotation);
        annotation.append(popup);
        document.body.append(container);

        removeAnnotationCommentDom(toHTMLElement(container), createComment());

        expect(annotation.parentElement).toBeNull();
        expect(popup.parentElement).toBeNull();
    });

    it('removes the matching draw-layer highlight visual and refreshes the composite overlay', () => {
        const refresh = vi.mocked(refreshHighlightCompositeOverlay);
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const annotation = createTestElement('highlightAnnotation', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        const matchingHighlight = createTestElement('highlight', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        const distantHighlight = createTestElement('highlight', {
            left: 600,
            top: 600,
            width: 150,
            height: 40,
        });
        annotation.dataset.annotationId = '12R';
        connectPage(container, page);
        connectToPage(page, annotation);
        appendDrawVisuals(
            page,
            matchingHighlight,
            distantHighlight,
        );

        removeAnnotationCommentDom(toHTMLElement(container), createComment());

        expect(matchingHighlight.parentElement).toBeNull();
        expect(distantHighlight.parentElement).not.toBeNull();
        expect(refresh).toHaveBeenCalledWith(page);
    });

    it('removes text markup visuals by geometry when no annotation id is available', () => {
        const refresh = vi.mocked(refreshHighlightCompositeOverlay);
        refresh.mockClear();
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const matchingHighlight = createTestElement('highlight', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        const distantHighlight = createTestElement('highlight', {
            left: 600,
            top: 600,
            width: 150,
            height: 40,
        });
        connectPage(container, page);
        appendDrawVisuals(
            page,
            matchingHighlight,
            distantHighlight,
        );

        removeAnnotationCommentDom(toHTMLElement(container), createComment({
            annotationId: null,
            subtype: 'Highlight',
        }));

        expect(matchingHighlight.parentElement).toBeNull();
        expect(distantHighlight.parentElement).not.toBeNull();
        expect(refresh).toHaveBeenCalledWith(page);
    });
});

describe('applyAnnotationCommentTextMarkupColor', () => {
    it.each([
        {
            expectedAttribute: 'fill',
            initialAttribute: '#ffd400',
            subtype: 'Highlight',
        },
        {
            expectedAttribute: 'stroke',
            initialAttribute: '#22c55e',
            subtype: 'Underline',
        },
        {
            expectedAttribute: 'stroke',
            initialAttribute: '#06b6d4',
            subtype: 'StrikeOut',
        },
    ])(
        'recolors visible %s markup immediately without waiting for save',
        ({
            expectedAttribute,
            initialAttribute,
            subtype,
        }) => {
            const container = createTestElement('viewer', {
                left: 0,
                top: 0,
                width: 1000,
                height: 1000,
            });
            const page = createTestElement('page_container', {
                left: 0,
                top: 0,
                width: 1000,
                height: 1000,
            });
            connectPage(container, page);
            const matchingMarkup = createTestElement('highlight', {
                left: 100,
                top: subtype === 'Highlight' ? 200 : 220,
                width: 200,
                height: subtype === 'Highlight' ? 50 : 3,
            });
            matchingMarkup.setAttribute(expectedAttribute, initialAttribute);
            appendDrawVisuals(page, matchingMarkup);

            const didUpdate = applyAnnotationCommentTextMarkupColor(
                toHTMLElement(container),
                createComment({ subtype }),
                '#ec4899',
            );

            expect(didUpdate).toBe(true);
            expect(matchingMarkup.getAttribute(expectedAttribute)).toBe('#ec4899');
        },
    );

    it('recolors canvas-backed materialized text markup without a page reload', () => {
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 100,
            height: 100,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 100,
            height: 100,
        });
        connectPage(container, page);
        const pixels = new Uint8ClampedArray([
            255,
            230,
            80,
            255,
            255,
            255,
            255,
            255,
            0,
            0,
            0,
            255,
            255,
            230,
            80,
            255,
        ]);
        const canvas = createTestCanvas({
            left: 0,
            top: 0,
            width: 2,
            height: 2,
        }, pixels);
        connectToPage(page, canvas);

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: null,
                subtype: 'Highlight',
                markerRect: {
                    left: 0,
                    top: 0,
                    width: 1,
                    height: 1,
                },
            }),
            '#ec4899',
        );

        expect(didUpdate).toBe(true);
        expect(canvas.putImageDataCalls).toBe(1);
        expect(Array.from(pixels)).toEqual([
            236,
            72,
            153,
            255,
            255,
            255,
            255,
            255,
            0,
            0,
            0,
            255,
            236,
            72,
            153,
            255,
        ]);
    });

    it('does not recolor overlapping highlight fill when repainting canvas-backed underline', () => {
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 100,
            height: 100,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 100,
            height: 100,
        });
        connectPage(container, page);
        const pixels = new Uint8ClampedArray([
            236,
            72,
            153,
            255,
            236,
            72,
            153,
            255,
            236,
            72,
            153,
            255,
            236,
            72,
            153,
            255,
            239,
            68,
            68,
            255,
            239,
            68,
            68,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
        ]);
        const canvas = createTestCanvas({
            left: 0,
            top: 0,
            width: 2,
            height: 4,
        }, pixels);
        connectToPage(page, canvas);

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: null,
                subtype: 'Underline',
                markerRect: {
                    left: 0,
                    top: 0,
                    width: 1,
                    height: 1,
                },
            }),
            '#22c55e',
            { sourceColor: '#ef4444' },
        );

        expect(didUpdate).toBe(true);
        expect(Array.from(pixels)).toEqual([
            236,
            72,
            153,
            255,
            236,
            72,
            153,
            255,
            236,
            72,
            153,
            255,
            236,
            72,
            153,
            255,
            34,
            197,
            94,
            255,
            34,
            197,
            94,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
        ]);
    });

    it('recolors matching highlight visuals and keeps annotation-layer highlight paint authoritative', () => {
        const refresh = vi.mocked(refreshHighlightCompositeOverlay);
        refresh.mockClear();
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const annotation = createTestElement('highlightAnnotation', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        annotation.dataset.annotationId = 'unmatched-id';
        annotation.style.backgroundColor = 'rgb(255, 255, 0)';

        const matchingHighlight = createTestElement('highlight', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        const distantHighlight = createTestElement('highlight', {
            left: 600,
            top: 600,
            width: 150,
            height: 40,
        });
        matchingHighlight.setAttribute('fill', '#fff066');
        distantHighlight.setAttribute('fill', '#fff066');
        connectPage(container, page);
        connectToPage(page, annotation);
        appendDrawVisuals(
            page,
            matchingHighlight,
            distantHighlight,
        );

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment(),
            '#22c55e',
        );

        expect(didUpdate).toBe(true);
        expect(annotation.style.backgroundColor).toBe('#22c55e');
        expect(matchingHighlight.getAttribute('fill')).toBe('#22c55e');
        expect(matchingHighlight.style.getPropertyValue('fill')).toBe('#22c55e');
        expect(distantHighlight.getAttribute('fill')).toBe('#fff066');
        expect(refresh).toHaveBeenCalledWith(page);
    });

    it('recolors thin underline visuals matched inside the text markup rect', () => {
        const refresh = vi.mocked(refreshHighlightCompositeOverlay);
        refresh.mockClear();
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const matchingUnderline = createTestElement('highlight', {
            left: 120,
            top: 360,
            width: 350,
            height: 3,
        });
        const distantUnderline = createTestElement('highlight', {
            left: 120,
            top: 620,
            width: 350,
            height: 3,
        });
        matchingUnderline.setAttribute('stroke', '#06b6d4');
        distantUnderline.setAttribute('stroke', '#06b6d4');
        connectPage(container, page);
        appendDrawVisuals(
            page,
            matchingUnderline,
            distantUnderline,
        );

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: null,
                subtype: 'Underline',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.4,
                    height: 0.2,
                },
            }),
            '#ec4899',
        );

        expect(didUpdate).toBe(true);
        expect(matchingUnderline.getAttribute('stroke')).toBe('#ec4899');
        expect(distantUnderline.getAttribute('stroke')).toBe('#06b6d4');
        expect(refresh).toHaveBeenCalledWith(page);
    });

    it('does not recolor non-highlight transparent rectangle outlines', () => {
        const refresh = vi.mocked(refreshHighlightCompositeOverlay);
        refresh.mockClear();
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        connectPage(container, page);
        const editorOutlineSvg = createTestElement('highlight', {
            left: 100,
            top: 200,
            width: 400,
            height: 80,
        });
        const outlineRect = createTestElement('rect', {
            left: 100,
            top: 200,
            width: 400,
            height: 80,
        });
        outlineRect.setAttribute('fill', 'none');
        outlineRect.setAttribute('stroke', '#111827');
        editorOutlineSvg.append(outlineRect);
        appendDrawVisuals(page, editorOutlineSvg);

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: null,
                subtype: 'Underline',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.4,
                    height: 0.08,
                },
            }),
            '#ec4899',
        );

        expect(didUpdate).toBe(false);
        expect(outlineRect.getAttribute('stroke')).toBe('#111827');
        expect(refresh).not.toHaveBeenCalled();
    });

    it('suppresses the base highlight fill when recoloring underline markup', () => {
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        connectPage(container, page);
        const baseHighlightSvg = createTestElement('highlight pdf-markup-subtype-draw-underline', {
            left: 100,
            top: 200,
            width: 400,
            height: 180,
        });
        baseHighlightSvg.setAttribute('fill', '#ef4444');
        const baseHighlightUse = createTestElement('use', {
            left: 100,
            top: 200,
            width: 400,
            height: 180,
        });
        baseHighlightUse.setAttribute('fill', '#ef4444');
        baseHighlightSvg.append(baseHighlightUse);
        const baseHighlightPath = createTestElement('path', {
            left: 100,
            top: 200,
            width: 400,
            height: 4,
        });
        baseHighlightPath.setAttribute('fill', 'none');
        baseHighlightPath.setAttribute('stroke', '#ef4444');
        baseHighlightSvg.append(baseHighlightPath);
        const underlineVisual = createTestElement('pdf-markup-subtype-draw-visual pdf-markup-subtype-draw-underline', {
            left: 100,
            top: 200,
            width: 400,
            height: 180,
        });
        const underlinePath = createTestElement('path', {
            left: 100,
            top: 200,
            width: 400,
            height: 4,
        });
        underlinePath.setAttribute('fill', 'none');
        underlinePath.setAttribute('stroke', '#ef4444');
        underlineVisual.append(underlinePath);
        appendDrawVisuals(
            page,
            baseHighlightSvg,
            underlineVisual,
        );

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: null,
                subtype: 'Underline',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.4,
                    height: 0.18,
                },
            }),
            '#22c55e',
        );

        expect(didUpdate).toBe(true);
        expect(baseHighlightSvg.getAttribute('fill')).toBe('transparent');
        expect(baseHighlightUse.getAttribute('fill')).toBe('transparent');
        expect(baseHighlightSvg.getAttribute('stroke')).toBe('transparent');
        expect(baseHighlightPath.getAttribute('stroke')).toBe('transparent');
        expect(underlinePath.getAttribute('stroke')).toBe('#22c55e');
    });

    it('suppresses unclassified PDF.js highlight geometry when recoloring underline markup', () => {
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        connectPage(container, page);
        const baseHighlightSvg = createTestElement('highlight', {
            left: 100,
            top: 200,
            width: 400,
            height: 180,
        });
        baseHighlightSvg.setAttribute('fill', '#ef4444');
        const baseHighlightPath = createTestElement('path', {
            left: 100,
            top: 200,
            width: 400,
            height: 4,
        });
        baseHighlightPath.setAttribute('fill', 'none');
        baseHighlightPath.setAttribute('stroke', '#ef4444');
        baseHighlightSvg.append(baseHighlightPath);
        const underlineVisual = createTestElement('pdf-markup-subtype-draw-visual pdf-markup-subtype-draw-underline', {
            left: 100,
            top: 200,
            width: 400,
            height: 180,
        });
        const underlinePath = createTestElement('path', {
            left: 100,
            top: 200,
            width: 400,
            height: 4,
        });
        underlinePath.setAttribute('fill', 'none');
        underlinePath.setAttribute('stroke', '#ef4444');
        underlineVisual.append(underlinePath);
        appendDrawVisuals(
            page,
            baseHighlightSvg,
            underlineVisual,
        );

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: null,
                subtype: 'Underline',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.4,
                    height: 0.18,
                },
            }),
            '#3b82f6',
        );

        expect(didUpdate).toBe(true);
        expect(baseHighlightSvg.getAttribute('fill')).toBe('transparent');
        expect(baseHighlightSvg.getAttribute('stroke')).toBe('transparent');
        expect(baseHighlightPath.getAttribute('stroke')).toBe('transparent');
        expect(underlinePath.getAttribute('stroke')).toBe('#3b82f6');
    });

    it('updates decorated annotation-layer markup without painting stale annotation box borders', () => {
        installInlineComputedStyle();
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const staleAnnotationNode = createTestElement('annotationLayerItem underlineAnnotation', {
            left: 100,
            top: 200,
            width: 400,
            height: 200,
        });
        staleAnnotationNode.dataset.annotationId = '12R0';
        staleAnnotationNode.style.textDecorationLine = 'underline';
        connectPage(container, page);
        connectToPage(page, staleAnnotationNode);

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: '12R0',
                subtype: 'Underline',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.4,
                    height: 0.2,
                },
            }),
            '#ef4444',
        );

        expect(didUpdate).toBe(true);
        expect(staleAnnotationNode.style.textDecorationColor).toBe('#ef4444');
        expect(staleAnnotationNode.style.borderColor).toBe('');
        expect(staleAnnotationNode.style.color).toBe('');
    });

    it('keeps edited highlight annotation-layer text visible when the stale canvas paint is suppressed', () => {
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const highlightNode = createTestElement('annotationLayerItem highlightAnnotation', {
            left: 100,
            top: 200,
            width: 400,
            height: 80,
        });
        const overlaidText = createTestElement('overlaidText', {
            left: 100,
            top: 200,
            width: 400,
            height: 80,
        });
        highlightNode.dataset.annotationId = '12R0';
        highlightNode.style.backgroundColor = '#fde047';
        highlightNode.append(overlaidText);
        connectPage(container, page);
        connectToPage(page, highlightNode);

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: '12R0',
                subtype: 'Highlight',
            }),
            '#86efac',
        );

        expect(didUpdate).toBe(true);
        expect(highlightNode.style.backgroundColor).toBe('#86efac');
        expect(overlaidText.style.backgroundColor).toBe('#86efac');
        expect(highlightNode.style.visibility).toBe('visible');
        expect(overlaidText.style.opacity).toBe('1');
    });

    it('does not synthesize duplicate underline overlays when no visible visual can be recolored', () => {
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        connectPage(container, page);

        const didUpdate = applyAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: null,
                subtype: 'Underline',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.2,
                    height: 0.05,
                },
            }),
            '#3b82f6',
        );

        expect(didUpdate).toBe(false);
    });

    it('creates a stable edited underline overlay from marker geometry', () => {
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        connectPage(container, page);

        const didUpdate = applyAnnotationCommentTextMarkupVisualOverlay(
            toHTMLElement(container),
            createComment({
                annotationId: '12R0',
                subtype: 'Underline',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.2,
                    height: 0.05,
                },
            }),
            '#22c55e',
        );

        const overlay = page.querySelector('svg[data-evb-edited-text-markup-overlay="true"]');
        const visual = overlay?.querySelector('.pdf-edited-text-markup-overlay__visual');
        const path = visual?.querySelector('path');
        expect(didUpdate).toBe(true);
        expect(overlay).toBeTruthy();
        expect(visual?.getAttribute('data-annotation-id')).toBe('12R0');
        expect(path?.getAttribute('stroke')).toBe('#22c55e');
        expect(path?.getAttribute('d')).toBe('M 0.1 0.25 L 0.3 0.25');
    });

    it('renders edited highlight overlays with raw color and configured opacity', () => {
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        connectPage(container, page);

        const didUpdate = applyAnnotationCommentTextMarkupVisualOverlay(
            toHTMLElement(container),
            createComment({
                annotationId: '12R0',
                subtype: 'Highlight',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.2,
                    height: 0.05,
                },
            }),
            '#22c55e',
            { highlightOpacity: 0.35 },
        );

        const overlay = page.querySelector('svg[data-evb-edited-text-markup-overlay="true"]');
        const rect = overlay?.querySelector('rect');
        expect(didUpdate).toBe(true);
        expect(rect?.getAttribute('fill')).toBe('#22c55e');
        expect(rect?.getAttribute('fill-opacity')).toBe('0.35');
    });

    it('suppresses native highlight paint when an edited highlight overlay is active', () => {
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const annotation = createTestElement('highlightAnnotation', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        const mark = createTestElement('mark', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        annotation.dataset.annotationId = '12R0';
        annotation.style.backgroundColor = '#b2ebc7';
        mark.style.backgroundColor = '#b2ebc7';
        annotation.append(mark);
        connectPage(container, page);
        connectToPage(page, annotation);

        const didUpdate = applyAnnotationCommentTextMarkupVisualOverlay(
            toHTMLElement(container),
            createComment({
                annotationId: '12R0',
                subtype: 'Highlight',
            }),
            '#22c55e',
            { highlightOpacity: 0.35 },
        );

        expect(didUpdate).toBe(true);
        expect(annotation.style.backgroundColor).toBe('transparent');
        expect(annotation.style.getPropertyValue('--pdf-markup-subtype-color')).toBe('#22c55e');
        expect(mark.style.backgroundColor).toBe('transparent');
    });

    it('converts blended preset highlight display colors back to raw overlay colors', () => {
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        connectPage(container, page);

        const didUpdate = applyAnnotationCommentTextMarkupVisualOverlay(
            toHTMLElement(container),
            createComment({
                annotationId: '12R0',
                subtype: 'Highlight',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.2,
                    height: 0.05,
                },
            }),
            '#b2ebc7',
            { highlightOpacity: 0.35 },
        );

        const overlay = page.querySelector('svg[data-evb-edited-text-markup-overlay="true"]');
        const rect = overlay?.querySelector('rect');
        expect(didUpdate).toBe(true);
        expect(rect?.getAttribute('fill')).toBe('#22c55e');
        expect(rect?.getAttribute('fill-opacity')).toBe('0.35');
    });

    it('draws edited strikeout color into thumbnail canvases after suppressing stale PDF paint', () => {
        const moveTo = vi.fn();
        const lineTo = vi.fn();
        type TTextMarkupCanvasContext = Pick<
            CanvasRenderingContext2D,
            | 'beginPath'
            | 'lineTo'
            | 'lineCap'
            | 'lineJoin'
            | 'lineWidth'
            | 'moveTo'
            | 'restore'
            | 'save'
            | 'stroke'
            | 'strokeStyle'
        >;
        const context: TTextMarkupCanvasContext = {
            beginPath: vi.fn(),
            lineTo,
            lineCap: 'butt',
            lineJoin: 'miter',
            lineWidth: 0,
            moveTo,
            restore: vi.fn(),
            save: vi.fn(),
            stroke: vi.fn(),
            strokeStyle: '',
        };
        const canvas = {
            height: 1000,
            width: 1000,
        } as HTMLCanvasElement;

        const didDraw = drawEditedTextMarkupCanvasVisual(
            canvas,
            context as CanvasRenderingContext2D,
            createComment({
                subtype: 'StrikeOut',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.2,
                    height: 0.05,
                },
            }),
            '#22c55e',
        );

        expect(didDraw).toBe(true);
        expect(moveTo).toHaveBeenCalledWith(100, 226);
        expect(lineTo).toHaveBeenCalledWith(300, 226);
        expect(context.strokeStyle).toBe('#22c55e');
        expect(context.lineWidth).toBe(1);
        expect(context.stroke).toHaveBeenCalled();
    });
});

describe('resolveAnnotationCommentTextMarkupColor', () => {
    it('reads highlight SVG paint instead of inherited black editor fill', () => {
        installInlineComputedStyle();
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        connectPage(container, page);
        const editor = createTestElement('highlightEditor', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        editor.dataset.annotationId = '42R0';
        editor.style.fill = 'rgb(0, 0, 0)';
        const renderedHighlight = createTestElement('highlight', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        renderedHighlight.setAttribute('fill', '#bad3fc');
        editor.append(renderedHighlight);
        connectToPage(page, editor);
        installPointElements([editor]);

        const diagnostics = resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
            toHTMLElement(container),
            createComment({
                annotationId: '42R0',
                color: '#3b82f6',
                subtype: 'Highlight',
            }),
            300,
            225,
        );

        expect(diagnostics.color).toBe('#bad3fc');
        expect(diagnostics.source).toBe('point:visual-node');
    });

    it('keeps an existing raw highlight swatch color instead of replacing it with display paint', () => {
        installInlineComputedStyle();
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        connectPage(container, page);
        const editor = createTestElement('highlightEditor', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        editor.dataset.annotationId = '42R0';
        editor.style.fill = 'rgb(0, 0, 0)';
        const renderedHighlight = createTestElement('highlight', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        renderedHighlight.setAttribute('fill', '#bad3fc');
        editor.append(renderedHighlight);
        connectToPage(page, editor);
        installPointElements([editor]);

        const resolved = resolveCommentWithRenderedTextMarkupColorAtPoint(
            toHTMLElement(container),
            createComment({
                annotationId: '42R0',
                color: '#3b82f6',
                subtype: 'Highlight',
            }),
            300,
            225,
        );

        expect(resolved?.color).toBe('#3b82f6');
    });

    it('uses the visible canvas color for context-menu swatches instead of a stale non-painted underline variable', () => {
        installInlineComputedStyle();
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        connectPage(container, page);
        const staleAnnotation = createTestElement('underlineAnnotation', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        staleAnnotation.dataset.annotationId = '42R0';
        staleAnnotation.style.setProperty('--pdf-markup-subtype-color', '#22c55e');
        connectToPage(page, staleAnnotation);

        const canvas = createTestElement('canvas', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        }) as HTMLCanvasElement;
        canvas.width = 1000;
        canvas.height = 1000;
        const getContext = vi.fn((_contextType: string, _options: unknown) => {
            const getImageData = (_left: number, _top: number, width: number, height: number) => {
                const data = new Uint8ClampedArray(width * height * 4);
                const centerIndex = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
                data[centerIndex] = 239;
                data[centerIndex + 1] = 68;
                data[centerIndex + 2] = 68;
                data[centerIndex + 3] = 255;
                return { data };
            };
            return { getImageData };
        });
        Object.defineProperty(canvas, 'getContext', {
            configurable: true,
            value: getContext,
        });
        connectToPage(page, canvas);
        installPointElements([
            staleAnnotation,
            canvas,
        ]);

        const diagnostics = resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
            toHTMLElement(container),
            createComment({
                annotationId: '42R0',
                subtype: 'Underline',
            }),
            300,
            225,
        );

        expect(diagnostics.color).toBe('#ef4444');
        expect(diagnostics.source).toBe('canvas');
    });

    it('prefers the visible underline line at the click point over stale editor dataset color', () => {
        installInlineComputedStyle();
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        connectPage(container, page);
        const staleEditor = createTestElement('highlightEditor pdf-markup-subtype-underline', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        staleEditor.dataset.annotationId = '42R0';
        staleEditor.dataset.markupSubtypeColor = '#22c55e';
        staleEditor.style.setProperty('--pdf-markup-subtype-color', '#22c55e');
        connectToPage(page, staleEditor);

        const visibleUnderline = createTestElement('pdf-markup-subtype-draw-visual pdf-markup-subtype-draw-underline', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        visibleUnderline.style.setProperty('--pdf-markup-subtype-color', '#ef4444');
        visibleUnderline.setAttribute('fill', 'none');
        visibleUnderline.setAttribute('stroke', '#ef4444');
        appendDrawVisuals(page, visibleUnderline);
        installPointElements([staleEditor]);

        const diagnostics = resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
            toHTMLElement(container),
            createComment({
                annotationId: '42R0',
                color: '#22c55e',
                subtype: 'Underline',
            }),
            200,
            225,
        );

        expect(diagnostics.color).toBe('#ef4444');
        expect(diagnostics.source).toBe('point:nearby-element');
    });

    it('ignores hidden stale strikeout editor paint and resolves the visible rendered line color', () => {
        installInlineComputedStyle();
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        connectPage(container, page);
        const hiddenEditor = createTestElement('strikeoutAnnotation', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        hiddenEditor.dataset.annotationId = '99R0';
        hiddenEditor.setAttribute('stroke', '#111827');
        hiddenEditor.style.opacity = '0';
        connectToPage(page, hiddenEditor);

        const visibleStrikeout = createTestElement('highlight', {
            left: 100,
            top: 225,
            width: 200,
            height: 3,
        });
        visibleStrikeout.setAttribute('stroke', '#ef4444');
        appendDrawVisuals(page, visibleStrikeout);

        const color = resolveAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: '99R0',
                subtype: 'StrikeOut',
            }),
        );

        expect(color).toBe('#ef4444');
    });

    it('uses underline stroke instead of a stale generic highlight fill', () => {
        installInlineComputedStyle();
        const container = createTestElement('viewer', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        const page = createTestElement('page_container', {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        connectPage(container, page);

        const matchingVisual = createTestElement('highlight', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        const staleFillPath = createTestElement('path', {
            left: 100,
            top: 200,
            width: 200,
            height: 50,
        });
        staleFillPath.setAttribute('fill', '#22c55e');
        const visibleLine = createTestElement('line', {
            left: 100,
            top: 225,
            width: 200,
            height: 3,
        });
        visibleLine.setAttribute('stroke', '#ef4444');
        matchingVisual.append(staleFillPath);
        matchingVisual.append(visibleLine);
        appendDrawVisuals(page, matchingVisual);

        const color = resolveAnnotationCommentTextMarkupColor(
            toHTMLElement(container),
            createComment({
                annotationId: null,
                subtype: 'Underline',
            }),
        );

        expect(color).toBe('#ef4444');
    });
});
