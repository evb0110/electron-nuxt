// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getMountedPageRowVisualStates,
    getMountedPageVisualReadiness,
    getMountedPageVisualState,
    isMountedPageRowCanvasUsable,
    isPageSkeletonVisible,
} from '@app/modules/pdf-viewer/runtime/navigation/singlePageVisualReadiness';

function createSkeleton(options?: {
    display?: string;
    height?: number;
    opacity?: string;
    visibility?: string;
    width?: number;
}) {
    const skeleton = document.createElement('div');
    skeleton.className = 'pdf-page-skeleton';
    skeleton.style.display = options?.display ?? '';
    skeleton.style.opacity = options?.opacity ?? '';
    skeleton.style.visibility = options?.visibility ?? '';
    skeleton.getBoundingClientRect = () => ({
        bottom: options?.height ?? 24,
        height: options?.height ?? 24,
        left: 0,
        right: options?.width ?? 24,
        top: 0,
        width: options?.width ?? 24,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    });
    return skeleton;
}

function createContainer(pages: HTMLElement[]) {
    const container = document.createElement('div');
    for (const page of pages) {
        container.append(page);
    }
    return container;
}

function createPage(options: {
    buffered?: boolean;
    hasCanvas?: boolean;
    pageNumber: number;
    rendered?: boolean;
    skeleton?: HTMLElement;
}) {
    const page = document.createElement('div');
    page.className = 'page_container';
    page.dataset.page = String(options.pageNumber);
    if (options.rendered) {
        page.classList.add('page_container--rendered');
    }
    if (options.buffered) {
        page.classList.add('page_container--buffered');
    }
    if (options.hasCanvas) {
        const canvasHost = document.createElement('div');
        canvasHost.className = 'page_canvas';
        canvasHost.append(document.createElement('canvas'));
        page.append(canvasHost);
    }
    if (options.skeleton) {
        page.append(options.skeleton);
    }
    return page;
}

describe('singlePageVisualReadiness', () => {
    it('reports empty visual state for missing containers and pages', () => {
        expect(getMountedPageVisualState(null, 1)).toEqual({
            buffered: false,
            hasCanvas: false,
            hasSkeleton: false,
            hasVisibleSkeleton: false,
            mounted: false,
            renderedClass: false,
        });

        expect(getMountedPageVisualState(createContainer([]), 1)).toEqual({
            buffered: false,
            hasCanvas: false,
            hasSkeleton: false,
            hasVisibleSkeleton: false,
            mounted: false,
            renderedClass: false,
        });
    });

    it('detects visible and hidden page skeletons', () => {
        expect(isPageSkeletonVisible(createSkeleton())).toBe(true);
        expect(isPageSkeletonVisible(createSkeleton({display: 'none'}))).toBe(false);
        expect(isPageSkeletonVisible(createSkeleton({opacity: '0'}))).toBe(false);
        expect(isPageSkeletonVisible(createSkeleton({visibility: 'hidden'}))).toBe(false);
        expect(isPageSkeletonVisible(createSkeleton({height: 0}))).toBe(false);

        const container = createContainer([
            createPage({
                hasCanvas: true,
                pageNumber: 1,
                rendered: true,
                skeleton: createSkeleton(),
            }),
            createPage({
                hasCanvas: true,
                pageNumber: 2,
                rendered: true,
                skeleton: createSkeleton({display: 'none'}),
            }),
        ]);

        expect(getMountedPageVisualState(container, 1)).toMatchObject({
            hasSkeleton: true,
            hasVisibleSkeleton: true,
        });
        expect(getMountedPageVisualReadiness(
            1,
            getMountedPageVisualState(container, 1),
        )).toMatchObject({
            hasUsableCanvas: false,
            usable: false,
        });
        expect(getMountedPageVisualState(container, 2)).toMatchObject({
            hasSkeleton: true,
            hasVisibleSkeleton: false,
        });
        expect(getMountedPageVisualReadiness(
            2,
            getMountedPageVisualState(container, 2),
        )).toMatchObject({
            hasUsableCanvas: true,
            usable: true,
        });
    });

    it('uses freshly-rendered navigation state to reject stale canvases', () => {
        const state = getMountedPageVisualState(
            createContainer([createPage({
                hasCanvas: true,
                pageNumber: 1,
                rendered: true,
            })]),
            1,
        );

        expect(getMountedPageVisualReadiness(1, state)).toMatchObject({
            freshlyRendered: true,
            hasUsableCanvas: true,
            usable: true,
        });
        expect(getMountedPageVisualReadiness(1, state, () => false)).toMatchObject({
            freshlyRendered: false,
            hasUsableCanvas: false,
            usable: false,
        });
    });

    it('keeps buffered rendered pages out of usable row readiness', () => {
        const container = createContainer([createPage({
            buffered: true,
            hasCanvas: true,
            pageNumber: 1,
            rendered: true,
        })]);
        const state = getMountedPageVisualState(container, 1);

        expect(state).toMatchObject({
            buffered: true,
            hasCanvas: true,
            renderedClass: true,
        });
        expect(getMountedPageVisualReadiness(1, state)).toMatchObject({
            hasUsableCanvas: true,
            usable: false,
        });
        expect(isMountedPageRowCanvasUsable(
            {
                start: 1,
                end: 1,
            },
            getMountedPageRowVisualStates(container, {
                start: 1,
                end: 1,
            }),
        )).toBe(false);
    });

    it('requires every page in a row to have an unbuffered usable canvas', () => {
        const range = {
            start: 1,
            end: 2,
        };
        const container = createContainer([
            createPage({
                hasCanvas: true,
                pageNumber: 1,
                rendered: true,
            }),
            createPage({
                hasCanvas: true,
                pageNumber: 2,
                rendered: true,
            }),
        ]);
        const rowVisualStates = getMountedPageRowVisualStates(container, range);
        const secondPageState = rowVisualStates[2];
        if (!secondPageState) {
            throw new Error('Expected row visual state for page 2');
        }

        expect(isMountedPageRowCanvasUsable(range, rowVisualStates)).toBe(true);
        expect(isMountedPageRowCanvasUsable(range, {
            ...rowVisualStates,
            2: {
                ...secondPageState,
                hasUsableCanvas: false,
            },
        })).toBe(false);
        expect(isMountedPageRowCanvasUsable({
            start: 1,
            end: 3,
        }, rowVisualStates)).toBe(false);
    });
});
