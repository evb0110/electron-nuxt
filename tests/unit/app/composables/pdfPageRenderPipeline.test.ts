import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    captureScrollSnapshot,
    restoreScrollFromSnapshot,
} from '@app/composables/pdf/pdfPageRenderPipeline';

function cast<T>(value: unknown): T {
    return value as T;
}

interface IPageStub {
    page: number;
    top: number;
    height: number;
}

interface IContainerStubOptions {
    pages: IPageStub[];
    scrollTop?: number;
    scrollLeft?: number;
    clientWidth?: number;
    clientHeight?: number;
    scrollWidth?: number;
    scrollHeight?: number;
}

function createContainerStub(options: IContainerStubOptions) {
    let scrollTop = options.scrollTop ?? 0;
    let scrollLeft = options.scrollLeft ?? 0;
    const pageElements = options.pages.map((page) =>
        cast<HTMLElement>({
            dataset: {page: String(page.page)},
            offsetTop: page.top,
            offsetHeight: page.height,
        }),
    );

    const container = cast<HTMLElement>({
        clientWidth: options.clientWidth ?? 100,
        clientHeight: options.clientHeight ?? 100,
        scrollWidth: options.scrollWidth ?? 1000,
        scrollHeight: options.scrollHeight ?? 1000,
        querySelectorAll: (selector: string) =>
            selector === '.page_container' ? pageElements : [],
        querySelector: (selector: string) => {
            const match = selector.match(/\.page_container\[data-page="(\d+)"\]/);
            if (!match?.[1]) {
                return null;
            }
            const pageNumber = Number.parseInt(match[1], 10);
            return pageElements.find((pageElement) => {
                const rawPage = pageElement.dataset.page;
                if (!rawPage) {
                    return false;
                }
                return Number.parseInt(rawPage, 10) === pageNumber;
            }) ?? null;
        },
    });

    Object.defineProperty(container, 'scrollTop', {
        get: () => scrollTop,
        set: (value: number) => {
            scrollTop = value;
        },
    });
    Object.defineProperty(container, 'scrollLeft', {
        get: () => scrollLeft,
        set: (value: number) => {
            scrollLeft = value;
        },
    });

    return {
        container,
        getScrollTop: () => scrollTop,
        getScrollLeft: () => scrollLeft,
    };
}

describe('pdfPageRenderPipeline scroll snapshots', () => {
    it('captures the most visible page as an anchor snapshot', () => {
        const {container} = createContainerStub({
            pages: [
                {
                    page: 1,
                    top: 0,
                    height: 120,
                },
                {
                    page: 2,
                    top: 140,
                    height: 140,
                },
                {
                    page: 3,
                    top: 320,
                    height: 120,
                },
            ],
            scrollTop: 180,
            clientHeight: 180,
            scrollWidth: 640,
            scrollHeight: 1600,
        });

        const snapshot = captureScrollSnapshot(container);
        expect(snapshot).not.toBeNull();
        expect(snapshot?.anchorPage).toBe(2);
        expect(snapshot?.anchorOffsetRatio).toBeCloseTo((180 - 140) / 140, 5);
    });

    it('restores scrollTop from page anchor when anchor page is mounted', () => {
        const {
            container,
            getScrollTop,
        } = createContainerStub({
            pages: [{
                page: 2,
                top: 500,
                height: 400,
            }],
            clientHeight: 200,
            scrollHeight: 2000,
            scrollWidth: 1200,
        });

        restoreScrollFromSnapshot(container, {
            width: 600,
            height: 1000,
            centerX: 300,
            centerY: 300,
            anchorPage: 2,
            anchorOffsetRatio: 0.25,
        });

        expect(getScrollTop()).toBeCloseTo(600, 5);
    });

    it('falls back to ratio-based restoration when anchor page is unavailable', () => {
        const {
            container,
            getScrollTop,
            getScrollLeft,
        } = createContainerStub({
            pages: [],
            clientWidth: 100,
            clientHeight: 100,
            scrollWidth: 600,
            scrollHeight: 800,
        });

        restoreScrollFromSnapshot(container, {
            width: 200,
            height: 200,
            centerX: 100,
            centerY: 120,
            anchorPage: 99,
            anchorOffsetRatio: 0.5,
        });

        expect(getScrollLeft()).toBeCloseTo(250, 5);
        expect(getScrollTop()).toBeCloseTo(430, 5);
    });
});
