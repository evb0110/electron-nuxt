// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import { requirePageNumber } from '@contracts/pageNumbers';
import { buildRangeFromPagePoint } from '@app/modules/pdf-viewer/engine/annotations/pdf-text-anchor-resolver/buildRangeFromPagePoint';

/**
 * A click on a page arrives as a normalized fraction of the page box, while the
 * text layer only knows client coordinates. This is the seam that converts one
 * into the other and picks the word under the pointer, so the cases that matter
 * are the ones where the conversion or the span lookup can come back empty.
 */

const PAGE_RECT = {
    bottom: 100,
    height: 100,
    left: 0,
    right: 200,
    top: 0,
    width: 200,
    x: 0,
    y: 0,
};

interface ITextSpanFixture {
    height: number;
    left: number;
    node: Node;
    top: number;
    width: number;
}

function stubRect(element: HTMLElement, rect: typeof PAGE_RECT) {
    element.getBoundingClientRect = () => ({
        ...rect,
        toJSON: () => rect,
    }) as DOMRect;
}

function createPage(spans: readonly ITextSpanFixture[]) {
    const pageContainer = document.createElement('div');
    stubRect(pageContainer, PAGE_RECT);

    const textLayer = document.createElement('div');
    textLayer.className = 'text-layer';
    pageContainer.append(textLayer);

    spans.forEach((span) => {
        const element = document.createElement('span');
        element.append(span.node);
        stubRect(element, {
            bottom: span.top + span.height,
            height: span.height,
            left: span.left,
            right: span.left + span.width,
            top: span.top,
            width: span.width,
            x: span.left,
            y: span.top,
        });
        textLayer.append(element);
    });

    document.body.append(pageContainer);
    return pageContainer;
}

function pointAt(pageContainer: HTMLElement, pageX: number, pageY: number) {
    return buildRangeFromPagePoint({
        pageContainer,
        pageNumber: requirePageNumber(1),
        pageX,
        pageY,
    });
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('buildRangeFromPagePoint', () => {
    it('selects the word under the normalized page point', () => {
        const page = createPage([{
            height: 20,
            left: 0,
            node: document.createTextNode('Hello world'),
            top: 0,
            width: 100,
        }]);

        const nearLeft = pointAt(page, 0.05, 0.05);
        expect(nearLeft?.toString()).toBe('Hello');

        const nearRight = pointAt(page, 0.45, 0.05);
        expect(nearRight?.toString()).toBe('world');
    });

    it('picks the closest span when several carry text', () => {
        const page = createPage([
            {
                height: 20,
                left: 0,
                node: document.createTextNode('first'),
                top: 0,
                width: 40,
            },
            {
                height: 20,
                left: 120,
                node: document.createTextNode('second'),
                top: 0,
                width: 60,
            },
        ]);

        expect(pointAt(page, 0.75, 0.05)?.toString()).toBe('second');
    });

    it('returns null when the page has no text layer spans', () => {
        expect(pointAt(createPage([]), 0.5, 0.5)).toBeNull();
    });

    it('returns null when the closest span holds no text node of its own', () => {
        const nested = document.createElement('b');
        nested.textContent = 'bold';
        const page = createPage([{
            height: 20,
            left: 0,
            node: nested,
            top: 0,
            width: 40,
        }]);

        expect(pointAt(page, 0.05, 0.05)).toBeNull();
    });
});
