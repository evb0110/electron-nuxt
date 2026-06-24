import { getPageContainerByNumber } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getPageContainerByNumber';

export interface IMountedPageVisualState {
    buffered: boolean;
    hasCanvas: boolean;
    hasSkeleton: boolean;
    hasVisibleSkeleton: boolean;
    mounted: boolean;
    renderedClass: boolean;
}

export interface IMountedPageVisualReadiness {
    freshlyRendered: boolean;
    hasUsableCanvas: boolean;
    usable: boolean;
}

export interface IPageRange {
    start: number;
    end: number;
}

export type TMountedPageVisualRowStates = Record<
    number,
    IMountedPageVisualState & IMountedPageVisualReadiness
>;

const EMPTY_MOUNTED_PAGE_VISUAL_STATE: IMountedPageVisualState = {
    buffered: false,
    hasCanvas: false,
    hasSkeleton: false,
    hasVisibleSkeleton: false,
    mounted: false,
    renderedClass: false,
};

export function isPageSkeletonVisible(skeleton: Element | null) {
    if (!skeleton) {
        return false;
    }

    const htmlSkeleton = skeleton as HTMLElement;
    const inlineOpacity = htmlSkeleton.style?.opacity ?? '';
    if (
        htmlSkeleton.style?.display === 'none'
        || htmlSkeleton.style?.visibility === 'hidden'
        || (inlineOpacity.length > 0 && Number(inlineOpacity) <= 0)
    ) {
        return false;
    }

    if (
        typeof window !== 'undefined'
        && typeof window.getComputedStyle === 'function'
        && skeleton instanceof window.Element
    ) {
        const style = window.getComputedStyle(skeleton);
        if (
            style.display === 'none'
            || style.visibility === 'hidden'
            || Number(style.opacity || '1') <= 0
        ) {
            return false;
        }
    }

    if (typeof htmlSkeleton.getBoundingClientRect === 'function') {
        const rect = htmlSkeleton.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return false;
        }
    }

    return true;
}

export function getMountedPageVisualState(
    container: HTMLElement | null,
    pageNumber: number,
): IMountedPageVisualState {
    if (!container) {
        return {...EMPTY_MOUNTED_PAGE_VISUAL_STATE};
    }

    const pageElement = getPageContainerByNumber(container, pageNumber);
    if (!pageElement) {
        return {...EMPTY_MOUNTED_PAGE_VISUAL_STATE};
    }

    const queryPageElement = typeof pageElement.querySelector === 'function'
        ? (selector: string) => pageElement.querySelector(selector)
        : () => null;

    const skeleton = queryPageElement('.pdf-page-skeleton');

    return {
        buffered: pageElement.classList?.contains('page_container--buffered') === true,
        hasCanvas: queryPageElement('.page_canvas canvas') !== null,
        hasSkeleton: skeleton !== null,
        hasVisibleSkeleton: isPageSkeletonVisible(skeleton),
        mounted: true,
        renderedClass: pageElement.classList?.contains('page_container--rendered') === true,
    };
}

export function getMountedPageVisualReadiness(
    pageNumber: number,
    state: IMountedPageVisualState,
    isPageFreshlyRenderedForNavigation?: ((pageNumber: number) => boolean) | undefined,
): IMountedPageVisualReadiness {
    const freshlyRendered = isPageFreshlyRenderedForNavigation?.(pageNumber) ?? state.renderedClass;
    const hasUsableCanvas = state.hasCanvas
        && state.renderedClass
        && freshlyRendered
        && !state.hasVisibleSkeleton;
    return {
        freshlyRendered,
        hasUsableCanvas,
        usable: !state.buffered && hasUsableCanvas,
    };
}

export function getMountedPageRowVisualStates(
    container: HTMLElement | null,
    range: IPageRange,
    isPageFreshlyRenderedForNavigation?: ((pageNumber: number) => boolean) | undefined,
): TMountedPageVisualRowStates {
    const states: TMountedPageVisualRowStates = {};
    for (let pageNumber = range.start; pageNumber <= range.end; pageNumber += 1) {
        const visualState = getMountedPageVisualState(container, pageNumber);
        states[pageNumber] = {
            ...visualState,
            ...getMountedPageVisualReadiness(
                pageNumber,
                visualState,
                isPageFreshlyRenderedForNavigation,
            ),
        };
    }
    return states;
}

export function isMountedPageRowCanvasUsable(
    range: IPageRange,
    rowVisualStates: TMountedPageVisualRowStates,
) {
    for (let pageNumber = range.start; pageNumber <= range.end; pageNumber += 1) {
        const state = rowVisualStates[pageNumber];
        if (!state || state.buffered || !state.hasUsableCanvas) {
            return false;
        }
    }
    return true;
}
