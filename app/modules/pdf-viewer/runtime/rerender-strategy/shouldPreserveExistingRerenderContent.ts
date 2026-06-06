import { isResizeRerenderSource } from '@app/modules/pdf-viewer/runtime/rerender-strategy/isResizeRerenderSource';

interface IPageRange {
    start: number;
    end: number;
}

const PRESERVE_EXISTING_RENDER_SOURCES = new Set([
    'zoom-change',
    'zoom-settle',
    'fit-mode',
    'fit-width-current-page',
]);

export function shouldPreserveExistingRerenderContent(options: {
    source: string;
    visibleRange: IPageRange;
    isPageRendered: (page: number) => boolean;
}) {
    const { source } = options;

    if (PRESERVE_EXISTING_RENDER_SOURCES.has(source)) {
        return true;
    }

    if (!isResizeRerenderSource(source)) {
        return false;
    }

    return true;
}
