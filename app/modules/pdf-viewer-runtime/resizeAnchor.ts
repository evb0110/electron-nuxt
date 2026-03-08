function normalizeResizeAnchorPage(
    page: number | null | undefined,
    totalPages: number,
) {
    if (!Number.isFinite(page) || !page || totalPages <= 0) {
        return null;
    }

    return Math.min(totalPages, Math.max(1, Math.floor(page)));
}

export function resolveResizeAnchorPage(input: {
    totalPages: number;
    mostVisiblePage: number | null;
    snapshotAnchorPage: number | null;
    currentPage: number;
}) {
    return normalizeResizeAnchorPage(input.currentPage, input.totalPages)
        ?? normalizeResizeAnchorPage(input.mostVisiblePage, input.totalPages)
        ?? normalizeResizeAnchorPage(input.snapshotAnchorPage, input.totalPages)
        ?? 1;
}
