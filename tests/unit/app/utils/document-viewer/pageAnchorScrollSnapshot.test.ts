// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    capturePageAnchorScrollSnapshot,
    restorePageAnchorScrollSnapshot,
} from '@app/utils/document-viewer/page-anchor-scroll-snapshot/pageAnchorScrollSnapshot';
import type { IScrollSnapshot } from '@app/types/pdfUi';

function defineReadonlyNumber(element: HTMLElement, property: string, value: number) {
    Object.defineProperty(element, property, {
        configurable: true,
        value,
    });
}

function createContainer(dimensions: {
    clientWidth: number;
    clientHeight: number;
    scrollWidth: number;
    scrollHeight: number;
    scrollLeft?: number;
    scrollTop?: number;
}) {
    const container = document.createElement('div');
    defineReadonlyNumber(container, 'clientWidth', dimensions.clientWidth);
    defineReadonlyNumber(container, 'clientHeight', dimensions.clientHeight);
    defineReadonlyNumber(container, 'scrollWidth', dimensions.scrollWidth);
    defineReadonlyNumber(container, 'scrollHeight', dimensions.scrollHeight);
    container.scrollLeft = dimensions.scrollLeft ?? 0;
    container.scrollTop = dimensions.scrollTop ?? 0;
    return container;
}

function appendPage(container: HTMLElement, options: {
    pageNumber: number;
    left: number;
    top: number;
    width: number;
    height: number;
}) {
    const page = document.createElement('section');
    page.dataset.pageNumber = String(options.pageNumber);
    defineReadonlyNumber(page, 'offsetLeft', options.left);
    defineReadonlyNumber(page, 'offsetTop', options.top);
    defineReadonlyNumber(page, 'offsetWidth', options.width);
    defineReadonlyNumber(page, 'offsetHeight', options.height);
    defineReadonlyNumber(page, 'clientWidth', options.width);
    defineReadonlyNumber(page, 'clientHeight', options.height);
    container.append(page);
    return page;
}

const pageSelector = '[data-page-number]';

describe('pageAnchorScrollSnapshot', () => {
    it('captures the page under the viewport anchor', () => {
        const container = createContainer({
            clientWidth: 200,
            clientHeight: 100,
            scrollWidth: 400,
            scrollHeight: 600,
            scrollLeft: 10,
            scrollTop: 160,
        });
        appendPage(container, {
            pageNumber: 1,
            left: 20,
            top: 20,
            width: 100,
            height: 100,
        });
        appendPage(container, {
            pageNumber: 2,
            left: 40,
            top: 150,
            width: 200,
            height: 200,
        });

        const snapshot = capturePageAnchorScrollSnapshot(container, { pageSelector });

        expect(snapshot).toMatchObject({
            width: 400,
            height: 600,
            centerX: 110,
            centerY: 210,
            anchorPage: 2,
            anchorInsidePage: true,
            anchorViewportX: 100,
            anchorViewportY: 50,
            anchorPageXRatio: 0.35,
            anchorPageYRatio: 0.3,
            anchorPageYOutsideEdge: 'inside',
            anchorPageYOutsideOffsetPx: null,
        });
    });

    it('restores scroll position from a mounted page anchor', () => {
        const container = createContainer({
            clientWidth: 200,
            clientHeight: 100,
            scrollWidth: 400,
            scrollHeight: 900,
        });
        appendPage(container, {
            pageNumber: 2,
            left: 30,
            top: 300,
            width: 200,
            height: 200,
        });
        const snapshot: IScrollSnapshot = {
            width: 400,
            height: 600,
            centerX: 100,
            centerY: 200,
            anchorPage: 2,
            anchorInsidePage: true,
            anchorViewportX: 50,
            anchorViewportY: 40,
            anchorContentXRatio: 0.2,
            anchorContentYRatio: 0.4,
            anchorPageXRatio: 0.25,
            anchorPageYRatio: 0.5,
        };

        restorePageAnchorScrollSnapshot(container, snapshot, { pageSelector });

        expect(container.scrollLeft).toBe(30);
        expect(container.scrollTop).toBe(360);
    });

    it('falls back to content ratio when the anchor page is not mounted', () => {
        const container = createContainer({
            clientWidth: 200,
            clientHeight: 100,
            scrollWidth: 400,
            scrollHeight: 1000,
        });
        const snapshot: IScrollSnapshot = {
            width: 400,
            height: 500,
            centerX: 100,
            centerY: 250,
            anchorPage: 12,
            anchorViewportX: 50,
            anchorViewportY: 25,
            anchorContentXRatio: 0.5,
            anchorContentYRatio: 0.5,
        };

        restorePageAnchorScrollSnapshot(container, snapshot, { pageSelector });

        expect(container.scrollLeft).toBe(150);
        expect(container.scrollTop).toBe(475);
    });
});
