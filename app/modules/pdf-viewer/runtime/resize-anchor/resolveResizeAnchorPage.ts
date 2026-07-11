import { clamp } from 'es-toolkit/math';

function normalizeResizeAnchorPage(
    page: number | null | undefined,
    totalPages: number,
) {
    if (!Number.isFinite(page) || !page || totalPages <= 0) {
        return null;
    }

    return clamp(Math.floor(page), 1, totalPages);
}

const MAX_CURRENT_PAGE_VIEWPORT_DRIFT = 1;

function isNearViewportCandidate(
    currentPage: number | null,
    viewportPage: number | null,
) {
    if (currentPage === null || viewportPage === null) {
        return false;
    }

    return Math.abs(currentPage - viewportPage) <= MAX_CURRENT_PAGE_VIEWPORT_DRIFT;
}

export function resolveResizeAnchorPage(input: {
    totalPages: number;
    mostVisiblePage: number | null;
    snapshotAnchorPage: number | null;
    currentPage: number;
}) {
    const currentPage = normalizeResizeAnchorPage(
        input.currentPage,
        input.totalPages,
    );
    const mostVisiblePage = normalizeResizeAnchorPage(
        input.mostVisiblePage,
        input.totalPages,
    );
    const snapshotAnchorPage = normalizeResizeAnchorPage(
        input.snapshotAnchorPage,
        input.totalPages,
    );

    const hasViewportCandidate = mostVisiblePage !== null || snapshotAnchorPage !== null;
    const shouldTrustCurrentPage = currentPage !== null
        && (
            !hasViewportCandidate
            || isNearViewportCandidate(currentPage, mostVisiblePage)
            || isNearViewportCandidate(currentPage, snapshotAnchorPage)
        );

    return (shouldTrustCurrentPage ? currentPage : null)
        ?? mostVisiblePage
        ?? snapshotAnchorPage
        ?? currentPage
        ?? 1;
}
