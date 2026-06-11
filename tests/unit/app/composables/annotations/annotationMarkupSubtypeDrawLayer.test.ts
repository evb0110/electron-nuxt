// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IPdfjsDrawLayer } from '@app/types/pdfjs';
import { createAnnotationMarkupSubtypeDrawLayer } from '@app/utils/pdf-viewer/annotations/annotation-markup-subtype-draw-layer/createAnnotationMarkupSubtypeDrawLayer';

interface ITestRect {
    height: number;
    left: number;
    top: number;
    width: number;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function toDomRect(rect: ITestRect): DOMRect {
    return new DOMRect(rect.left, rect.top, rect.width, rect.height);
}

function setElementRect(element: Element, rect: ITestRect) {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(toDomRect(rect));
}

function createSvgElement<TElement extends SVGElement = SVGElement>(
    tagName: string,
    className = '',
) {
    const element = document.createElementNS(SVG_NAMESPACE, tagName) as TElement;
    if (className) {
        element.setAttribute('class', className);
    }
    return element;
}

afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
});

describe('createAnnotationMarkupSubtypeDrawLayer', () => {
    it('removes stale standalone underline visuals before drawing the recolored visual', () => {
        const page = document.createElement('div');
        page.classList.add('page_container');
        setElementRect(page, {
            left: 0,
            top: 0,
            width: 1000,
            height: 1000,
        });
        document.body.append(page);

        const pageCanvas = document.createElement('div');
        pageCanvas.classList.add('page_canvas');
        page.append(pageCanvas);

        const rect = {
            left: 100,
            top: 200,
            width: 400,
            height: 80,
        };
        const highlightSvg = createSvgElement<SVGSVGElement>(
            'svg',
            'highlight pdf-markup-subtype-draw-underline',
        );
        highlightSvg.style.left = '10%';
        highlightSvg.style.top = '20%';
        highlightSvg.style.width = '40%';
        highlightSvg.style.height = '8%';
        highlightSvg.setAttribute('fill', '#ef4444');
        setElementRect(highlightSvg, rect);

        const staleBasePath = createSvgElement<SVGPathElement>('path');
        staleBasePath.setAttribute('stroke', '#ef4444');
        highlightSvg.append(staleBasePath);
        pageCanvas.append(highlightSvg);

        const staleUnderlineSvg = createSvgElement<SVGSVGElement>(
            'svg',
            'draw pdf-markup-subtype-draw-visual pdf-markup-subtype-draw-visual--underline pdf-markup-subtype-draw-underline',
        );
        setElementRect(staleUnderlineSvg, rect);
        pageCanvas.append(staleUnderlineSvg);

        const editorDiv = document.createElement('div');
        setElementRect(editorDiv, rect);
        page.append(editorDiv);

        const draw = vi.fn((_options: unknown) => ({ id: 7 }));
        const drawLayer: IPdfjsDrawLayer = {
            draw,
            remove: vi.fn(),
        };
        const manager = createAnnotationMarkupSubtypeDrawLayer();

        const didApply = manager.applyMarkupSubtypeDrawLayerClass(
            {
                div: editorDiv,
                parent: { drawLayer },
                pageDimensions: [
                    1000,
                    1000,
                ],
                __evbMarkupBoxes: [{
                    x: 0.1,
                    y: 0.2,
                    width: 0.4,
                    height: 0.08,
                }],
            },
            'Underline',
            '#22c55e',
        );

        expect(didApply).toBe(true);
        expect(staleUnderlineSvg.isConnected).toBe(false);
        expect(page.querySelectorAll('.pdf-markup-subtype-draw-visual')).toHaveLength(0);
        expect(highlightSvg.getAttribute('fill')).toBe('transparent');
        expect(highlightSvg.style.getPropertyValue('fill')).toBe('transparent');
        expect(staleBasePath.getAttribute('stroke')).toBe('transparent');
        expect(draw).toHaveBeenCalledTimes(1);
        expect(draw.mock.calls[0]?.[0]).toMatchObject({
            path: { stroke: '#22c55e' },
            root: {
                fill: 'transparent',
                'fill-opacity': '0',
            },
            rootClass: {
                'pdf-markup-subtype-draw-visual--underline': true,
                'pdf-markup-subtype-draw-underline': true,
            },
        });
    });
});
