import { getViewportVisibilityFromDom } from '@app/utils/pdf-viewer/pdf-scroll-visibility/getViewportVisibilityFromDom';

export function getMostVisiblePageFromDom(
    container: HTMLElement,
    totalPages: number,
) {
    return getViewportVisibilityFromDom(container, totalPages).mostVisiblePage;
}
