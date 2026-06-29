import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getPageRowGeometry,
    getPageScrollBounds,
    resolveContinuousNavigationTargetLeft,
    resolveContinuousNavigationTargetTop,
    resolveMountedPageSnapTarget,
} from '@app/modules/pdf-viewer/runtime/navigation/singlePageScrollGeometry';
import { cast } from '@tests/helpers/cast';

interface ITestPageGeometry {
    offsetLeft?: number;
    offsetTop: number;
    offsetWidth?: number;
    offsetHeight: number;
}

function createGeometryContainer(options: {
    clientHeight: number;
    clientWidth?: number;
    pages: ITestPageGeometry[];
    scrollHeight: number;
    scrollWidth?: number;
}) {
    const clientWidth = options.clientWidth ?? 100;
    const pageElements = options.pages.map((page, index) => cast<HTMLElement>({
        clientHeight: page.offsetHeight,
        clientWidth: page.offsetWidth ?? clientWidth,
        dataset: { page: String(index + 1) },
        offsetHeight: page.offsetHeight,
        offsetLeft: page.offsetLeft ?? 0,
        offsetTop: page.offsetTop,
        offsetWidth: page.offsetWidth ?? clientWidth,
    }));

    const container = cast<HTMLElement>({
        clientHeight: options.clientHeight,
        clientWidth,
        scrollHeight: options.scrollHeight,
        scrollWidth: options.scrollWidth ?? clientWidth,
        querySelector: (selector: string) => {
            const match = selector.match(/\.page_container\[data-page="(\d+)"\]/);
            if (!match?.[1]) {
                return null;
            }
            const pageNumber = Number.parseInt(match[1], 10);
            return pageElements[pageNumber - 1] ?? null;
        },
    });

    return {
        container,
        pageElements,
    };
}

describe('singlePageScrollGeometry', () => {
    it('uses the mounted spread row for page scroll bounds', () => {
        const { container } = createGeometryContainer({
            clientHeight: 100,
            pages: [
                {
                    offsetTop: 10,
                    offsetHeight: 70,
                },
                {
                    offsetTop: 120,
                    offsetHeight: 180,
                },
                {
                    offsetTop: 115,
                    offsetHeight: 130,
                },
            ],
            scrollHeight: 500,
        });

        expect(getPageRowGeometry({
            container,
            pageNumber: 2,
            totalPages: 3,
            viewMode: 'facing',
        })).toEqual({
            top: 10,
            height: 290,
        });
        expect(getPageScrollBounds({
            container,
            pageNumber: 2,
            scaledMargin: 20,
            totalPages: 3,
            viewMode: 'facing',
        })).toEqual({
            min: 0,
            max: 190,
        });
    });

    it('resolves mounted pageYRatio snaps from the page box inside a spread row', () => {
        const {
            container,
            pageElements,
        } = createGeometryContainer({
            clientHeight: 100,
            pages: [
                {
                    offsetTop: 10,
                    offsetHeight: 70,
                },
                {
                    offsetTop: 120,
                    offsetHeight: 180,
                },
                {
                    offsetTop: 115,
                    offsetHeight: 130,
                },
            ],
            scrollHeight: 500,
        });

        expect(resolveMountedPageSnapTarget({
            anchor: 'center',
            container,
            scaledMargin: 20,
            scrollOptions: { pageYRatio: 0.5 },
            targetPage: 2,
            targetPageElement: pageElements[1]!,
            totalPages: 3,
            viewMode: 'facing',
        })).toEqual({
            left: null,
            top: 190,
        });
    });

    it('clamps marker horizontal snap targets to page and container bounds', () => {
        const {
            container,
            pageElements,
        } = createGeometryContainer({
            clientHeight: 100,
            clientWidth: 100,
            pages: [{
                offsetLeft: 40,
                offsetTop: 20,
                offsetWidth: 220,
                offsetHeight: 120,
            }],
            scrollHeight: 300,
            scrollWidth: 260,
        });

        expect(resolveMountedPageSnapTarget({
            anchor: 'top',
            container,
            scaledMargin: 20,
            scrollOptions: {markerRect: {
                left: 0.98,
                top: 0.2,
                width: 0.1,
                height: 0.1,
            }},
            targetPage: 1,
            targetPageElement: pageElements[0]!,
            totalPages: 1,
            viewMode: 'single',
        })).toEqual({
            left: 160,
            top: 0,
        });
    });

    it('resolves continuous marker targets from the mounted page geometry', () => {
        const {
            container,
            pageElements,
        } = createGeometryContainer({
            clientHeight: 100,
            clientWidth: 100,
            pages: [{
                offsetLeft: 30,
                offsetTop: 140,
                offsetWidth: 220,
                offsetHeight: 180,
            }],
            scrollHeight: 400,
            scrollWidth: 260,
        });
        const markerRect = {
            left: 0.5,
            top: 0.25,
            width: 0.2,
            height: 0.5,
        };

        expect(resolveContinuousNavigationTargetTop({
            container,
            scaledMargin: 20,
            scrollOptions: { markerRect },
            targetPageElement: pageElements[0]!,
        })).toBe(180);
        expect(resolveContinuousNavigationTargetLeft({
            container,
            scaledMargin: 20,
            scrollOptions: { markerRect },
            targetPageElement: pageElements[0]!,
        })).toBe(112);
    });
});
