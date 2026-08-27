const DEFAULT_ANNOTATION_EDITOR_FALLBACK_PAGE_RADIUS = 8;
const MAX_ANNOTATION_EDITOR_FALLBACK_PAGE_RADIUS = 32;

export interface IAnnotationEditorPageSearchOptions {
    preferredPageIndex: number;
    numPages: number;
    annotationPageIndexes?: Iterable<number> | null | undefined;
    mountedPageIndexes?: Iterable<number> | null | undefined;
    fallbackPageRadius?: number;
}

function normalizePageIndex(pageIndex: number, maxPageIndex: number) {
    if (!Number.isFinite(pageIndex)) {
        return 0;
    }
    return Math.min(maxPageIndex, Math.max(0, Math.trunc(pageIndex)));
}

function addPageIndex(
    pages: Set<number>,
    pageIndex: number,
    maxPageIndex: number,
) {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex > maxPageIndex) {
        return;
    }
    pages.add(pageIndex);
}

/**
 * Build the page order used when a direct editor lookup is unavailable.
 *
 * The native index and mounted-page list are sparse inputs. The final local
 * window is deliberately bounded so a stale or incomplete index cannot turn
 * a lookup into a document-wide scan.
 */
export function getAnnotationEditorPageSearchOrder({
    annotationPageIndexes,
    fallbackPageRadius = DEFAULT_ANNOTATION_EDITOR_FALLBACK_PAGE_RADIUS,
    mountedPageIndexes,
    numPages,
    preferredPageIndex,
}: IAnnotationEditorPageSearchOptions) {
    if (!Number.isSafeInteger(numPages) || numPages <= 0) {
        return [];
    }

    const maxPageIndex = numPages - 1;
    const preferred = normalizePageIndex(preferredPageIndex, maxPageIndex);
    const pages = new Set<number>([preferred]);
    for (const pageIndex of annotationPageIndexes ?? []) {
        addPageIndex(pages, pageIndex, maxPageIndex);
    }
    for (const pageIndex of mountedPageIndexes ?? []) {
        addPageIndex(pages, pageIndex, maxPageIndex);
    }

    const radius = Number.isFinite(fallbackPageRadius)
        ? Math.min(MAX_ANNOTATION_EDITOR_FALLBACK_PAGE_RADIUS, Math.max(0, Math.trunc(fallbackPageRadius)))
        : DEFAULT_ANNOTATION_EDITOR_FALLBACK_PAGE_RADIUS;
    const firstFallbackPage = Math.max(0, preferred - radius);
    const lastFallbackPage = Math.min(maxPageIndex, preferred + radius);
    for (let pageIndex = firstFallbackPage; pageIndex <= lastFallbackPage; pageIndex += 1) {
        pages.add(pageIndex);
    }

    return [...pages];
}
