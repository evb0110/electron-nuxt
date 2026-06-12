import { getViewportVisibilityFromDom } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getViewportVisibilityFromDom';

export function getMostVisiblePageFromDom(
    container: HTMLElement,
    totalPages: number,
) {
    return getViewportVisibilityFromDom(container, totalPages).mostVisiblePage;
}
