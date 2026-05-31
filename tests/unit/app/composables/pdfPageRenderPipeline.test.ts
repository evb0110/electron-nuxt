import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    captureScrollSnapshot,
    restoreScrollFromSnapshot,
} from '@app/composables/pdf/pdfPageRenderPipeline';
import { cast } from '../../../helpers/cast';

interface IPageStub {
    page: number;
    left?: number;
    width?: number;
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
            offsetLeft: page.left ?? 0,
            offsetWidth: page.width ?? 100,
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
    it('captures a page-local anchor snapshot at viewport center by default', () => {
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
        expect(snapshot?.anchorInsidePage).toBe(true);
        expect(snapshot?.anchorViewportY).toBe(90);
        expect(snapshot?.anchorPageYRatio).toBeCloseTo((180 + 90 - 140) / 140, 5);
    });

    it('captures and restores pointer-anchored page-local coordinates across both axes', () => {
        const {container} = createContainerStub({
            pages: [{
                page: 2,
                left: 150,
                width: 300,
                top: 500,
                height: 400,
            }],
            scrollLeft: 100,
            scrollTop: 450,
            clientWidth: 200,
            clientHeight: 200,
            scrollWidth: 1000,
            scrollHeight: 2400,
        });

        const snapshot = captureScrollSnapshot(container, {
            anchorViewportX: 140,
            anchorViewportY: 100,
        });
        expect(snapshot).not.toBeNull();
        expect(snapshot?.anchorPage).toBe(2);
        expect(snapshot?.anchorInsidePage).toBe(true);
        expect(snapshot?.anchorPageXRatio).toBeCloseTo((240 - 150) / 300, 5);
        expect(snapshot?.anchorPageYRatio).toBeCloseTo((550 - 500) / 400, 5);
        expect(snapshot?.anchorViewportX).toBe(140);
        expect(snapshot?.anchorViewportY).toBe(100);

        const restored = createContainerStub({
            pages: [{
                page: 2,
                left: 180,
                width: 450,
                top: 620,
                height: 600,
            }],
            clientWidth: 200,
            clientHeight: 200,
            scrollWidth: 1400,
            scrollHeight: 3200,
        });

        restoreScrollFromSnapshot(restored.container, snapshot);
        expect(restored.getScrollLeft()).toBeCloseTo(180 + (90 / 300) * 450 - 140, 5);
        expect(restored.getScrollTop()).toBeCloseTo(620 + (50 / 400) * 600 - 100, 5);
    });

    it('can capture a preferred anchor page even when the viewport anchor is on a neighboring page', () => {
        const {container} = createContainerStub({
            pages: [
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
            scrollTop: 250,
            clientHeight: 180,
            scrollWidth: 640,
            scrollHeight: 1600,
        });

        const snapshot = captureScrollSnapshot(container, { preferredAnchorPage: 2 });

        expect(snapshot).not.toBeNull();
        expect(snapshot?.anchorPage).toBe(2);
        expect(snapshot?.anchorInsidePage).toBe(false);
        expect(snapshot?.anchorPageYOutsideEdge).toBe('below');
        expect(snapshot?.anchorPageYOutsideOffsetPx).toBe(60);

        const restored = createContainerStub({
            pages: [{
                page: 2,
                top: 500,
                height: 280,
            }],
            clientWidth: 100,
            clientHeight: 180,
            scrollWidth: 640,
            scrollHeight: 2000,
        });

        restoreScrollFromSnapshot(restored.container, snapshot);
        expect(restored.getScrollTop()).toBeCloseTo(500 + 280 + 60 - 90, 5);
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

    it('can restore by ratio even when page anchor is available', () => {
        const {
            container,
            getScrollTop,
            getScrollLeft,
        } = createContainerStub({
            pages: [{
                page: 2,
                top: 500,
                height: 400,
            }],
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
            anchorPage: 2,
            anchorOffsetRatio: 0.25,
        }, {preferPageAnchor: false});

        expect(getScrollLeft()).toBeCloseTo(250, 5);
        expect(getScrollTop()).toBeCloseTo(430, 5);
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

    it('can skip vertical ratio fallback when page anchor is unavailable', () => {
        const {
            container,
            getScrollTop,
            getScrollLeft,
        } = createContainerStub({
            pages: [],
            scrollTop: 77,
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
        }, { allowVerticalRatioFallback: false });

        expect(getScrollLeft()).toBeCloseTo(250, 5);
        expect(getScrollTop()).toBe(77);
    });

    it('uses anchor content ratios for ratio-based restoration when provided', () => {
        const {
            container,
            getScrollTop,
            getScrollLeft,
        } = createContainerStub({
            pages: [],
            clientWidth: 100,
            clientHeight: 100,
            scrollWidth: 1000,
            scrollHeight: 1000,
        });

        restoreScrollFromSnapshot(container, {
            width: 200,
            height: 200,
            centerX: 10,
            centerY: 20,
            anchorContentXRatio: 0.8,
            anchorContentYRatio: 0.6,
            anchorViewportX: 20,
            anchorViewportY: 40,
        });

        expect(getScrollLeft()).toBeCloseTo(780, 5);
        expect(getScrollTop()).toBeCloseTo(560, 5);
    });

    it('can restore vertical anchor without changing horizontal scroll', () => {
        const {
            container,
            getScrollTop,
            getScrollLeft,
        } = createContainerStub({
            pages: [{
                page: 2,
                top: 500,
                height: 400,
            }],
            scrollLeft: 12,
            clientWidth: 100,
            clientHeight: 200,
            scrollWidth: 1200,
            scrollHeight: 2000,
        });

        restoreScrollFromSnapshot(container, {
            width: 600,
            height: 1000,
            centerX: 300,
            centerY: 300,
            anchorPage: 2,
            anchorOffsetRatio: 0.25,
        }, {restoreHorizontal: false});

        expect(getScrollLeft()).toBe(12);
        expect(getScrollTop()).toBeCloseTo(600, 5);
    });

    it('can keep both axes untouched when requested', () => {
        const {
            container,
            getScrollTop,
            getScrollLeft,
        } = createContainerStub({
            pages: [{
                page: 2,
                top: 500,
                height: 400,
            }],
            scrollTop: 33,
            scrollLeft: 12,
            clientWidth: 100,
            clientHeight: 200,
            scrollWidth: 1200,
            scrollHeight: 2000,
        });

        restoreScrollFromSnapshot(container, {
            width: 600,
            height: 1000,
            centerX: 300,
            centerY: 300,
            anchorPage: 2,
            anchorOffsetRatio: 0.25,
        }, {
            restoreHorizontal: false,
            restoreVertical: false,
        });

        expect(getScrollLeft()).toBe(12);
        expect(getScrollTop()).toBe(33);
    });

    it('marks snapshot as outside-page when viewport anchor is not inside any page', () => {
        const {container} = createContainerStub({
            pages: [{
                page: 2,
                left: 120,
                width: 300,
                top: 500,
                height: 400,
            }],
            scrollTop: 500,
            scrollLeft: 0,
            clientWidth: 200,
            clientHeight: 200,
            scrollWidth: 1200,
            scrollHeight: 2400,
        });

        const snapshot = captureScrollSnapshot(container, {
            anchorViewportX: 20,
            anchorViewportY: 100,
        });

        expect(snapshot).not.toBeNull();
        expect(snapshot?.anchorPage).toBe(2);
        expect(snapshot?.anchorInsidePage).toBe(false);
        expect(snapshot?.anchorPageYOutsideEdge).toBe('inside');
        expect(snapshot?.anchorPageYOutsideOffsetPx).toBeNull();
    });

    it('preserves fixed vertical offset when anchor is in inter-page gap below page', () => {
        const {container} = createContainerStub({
            pages: [{
                page: 2,
                left: 100,
                width: 300,
                top: 500,
                height: 400,
            }],
            scrollTop: 820,
            clientWidth: 200,
            clientHeight: 200,
            scrollWidth: 1200,
            scrollHeight: 3200,
        });

        const snapshot = captureScrollSnapshot(container, {
            anchorViewportX: 100,
            anchorViewportY: 100,
        });
        expect(snapshot).not.toBeNull();
        expect(snapshot?.anchorInsidePage).toBe(false);
        expect(snapshot?.anchorPageYOutsideEdge).toBe('below');
        expect(snapshot?.anchorPageYOutsideOffsetPx).toBe(20);

        const restored = createContainerStub({
            pages: [{
                page: 2,
                left: 100,
                width: 450,
                top: 700,
                height: 800,
            }],
            clientWidth: 200,
            clientHeight: 200,
            scrollWidth: 1600,
            scrollHeight: 4200,
        });

        restoreScrollFromSnapshot(restored.container, snapshot);
        expect(restored.getScrollTop()).toBeCloseTo(700 + 800 + 20 - 100, 5);
    });

    it('clamps oversized outside-page offsets to page edge during restore', () => {
        const {
            container,
            getScrollTop,
        } = createContainerStub({
            pages: [{
                page: 106,
                top: 95000,
                height: 900,
            }],
            clientWidth: 200,
            clientHeight: 800,
            scrollWidth: 2400,
            scrollHeight: 220000,
        });

        restoreScrollFromSnapshot(container, {
            width: 2000,
            height: 200000,
            centerX: 1000,
            centerY: 100000,
            anchorPage: 106,
            anchorInsidePage: false,
            anchorPageYRatio: 3.03,
            anchorPageYOutsideEdge: 'below',
            anchorPageYOutsideOffsetPx: 2030.5,
            anchorViewportY: 398,
        });

        expect(getScrollTop()).toBeCloseTo(95000 + 900 - 398, 5);
    });

    it('restores with page-anchor ratios even when snapshot anchor point was outside page bounds', () => {
        const {
            container,
            getScrollTop,
            getScrollLeft,
        } = createContainerStub({
            pages: [{
                page: 2,
                left: 100,
                width: 300,
                top: 500,
                height: 400,
            }],
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
            anchorPage: 2,
            anchorInsidePage: false,
            anchorOffsetRatio: 0.75,
            anchorPageXRatio: 0.95,
            anchorPageYRatio: 0.9,
        });

        expect(getScrollLeft()).toBeCloseTo(335, 5);
        expect(getScrollTop()).toBeCloseTo(700, 5);
    });

    it('rejects negative outside-page offsets and falls back to clamped page ratio', () => {
        const {
            container,
            getScrollTop,
        } = createContainerStub({
            pages: [{
                page: 2,
                left: 100,
                width: 300,
                top: 500,
                height: 400,
            }],
            clientWidth: 200,
            clientHeight: 200,
            scrollWidth: 1200,
            scrollHeight: 2400,
        });

        restoreScrollFromSnapshot(container, {
            width: 800,
            height: 1600,
            centerX: 400,
            centerY: 800,
            anchorPage: 2,
            anchorInsidePage: false,
            anchorPageYRatio: 0.5,
            anchorPageYOutsideEdge: 'below',
            anchorPageYOutsideOffsetPx: -50,
            anchorViewportY: 0,
        });

        expect(getScrollTop()).toBeCloseTo(500 + 0.5 * 400, 5);
    });

    it('uses zero ratios when neither page ratios nor offset ratio are present', () => {
        const {
            container,
            getScrollTop,
            getScrollLeft,
        } = createContainerStub({
            pages: [{
                page: 2,
                left: 120,
                width: 300,
                top: 500,
                height: 400,
            }],
            clientWidth: 100,
            clientHeight: 100,
            scrollWidth: 800,
            scrollHeight: 1600,
        });

        restoreScrollFromSnapshot(container, {
            width: 400,
            height: 800,
            centerX: 200,
            centerY: 400,
            anchorPage: 2,
            anchorViewportX: 0,
            anchorViewportY: 0,
        });

        expect(getScrollLeft()).toBeCloseTo(120, 5);
        expect(getScrollTop()).toBeCloseTo(500, 5);
    });
});
