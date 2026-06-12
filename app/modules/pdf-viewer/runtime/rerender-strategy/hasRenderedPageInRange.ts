import type { IPageRange } from '@app/types/pdf';


export function hasRenderedPageInRange(
    visibleRange: IPageRange,
    isPageRendered: (page: number) => boolean,
) {
    const start = Math.max(1, Math.trunc(visibleRange.start));
    const end = Math.max(start, Math.trunc(visibleRange.end));

    for (let page = start; page <= end; page += 1) {
        if (isPageRendered(page)) {
            return true;
        }
    }

    return false;
}
