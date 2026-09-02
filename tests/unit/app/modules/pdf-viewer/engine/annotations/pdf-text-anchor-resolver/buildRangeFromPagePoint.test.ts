// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {buildRangeFromPagePoint} from '@app/modules/pdf-viewer/engine/annotations/pdf-text-anchor-resolver/buildRangeFromPagePoint';

function setRect(element: Element, rect: {
    left: number;
    top: number;
    width: number;
    height: number
}) {
    Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            ...rect,
            right: rect.left + rect.width,
            bottom: rect.top + rect.height,
        }),
    });
}

describe('buildRangeFromPagePoint', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it('builds a range around the text nearest to a normalized page point', () => {
        const page = document.createElement('div');
        const textLayer = document.createElement('div');
        textLayer.className = 'text-layer';
        const span = document.createElement('span');
        span.textContent = 'alpha beta';
        textLayer.append(span);
        page.append(textLayer);
        document.body.append(page);

        setRect(page, {
            left: 100,
            top: 50,
            width: 200,
            height: 100,
        });
        setRect(span, {
            left: 100,
            top: 50,
            width: 100,
            height: 20,
        });

        const range = buildRangeFromPagePoint({
            pageContainer: page,
            pageNumber: 1,
            pageX: 0.1,
            pageY: 0.1,
        });

        expect(range?.toString()).toBe('alpha');
        expect(range?.startContainer).toBe(span.firstChild);
        expect(range?.startOffset).toBe(0);
        expect(range?.endOffset).toBe(5);
    });
});
