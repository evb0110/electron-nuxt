export const SCAN_CLEANUP_PAGE_SCOPE_ERROR_CODE = 'SCAN_CLEANUP_INVALID_PAGE_SCOPE' as const;

export class ScanCleanupPageScopeError extends Error {
    readonly code = SCAN_CLEANUP_PAGE_SCOPE_ERROR_CODE;
    readonly pageNumbers: readonly number[];
    readonly documentPageCount: number;

    constructor(message: string, pageNumbers: readonly number[], documentPageCount: number) {
        super(message);
        this.name = 'ScanCleanupPageScopeError';
        this.pageNumbers = [...pageNumbers];
        this.documentPageCount = documentPageCount;
    }
}

/**
 * Validates the one-based page scope before any DPI probing or native
 * detection starts. The returned order is canonical so every caller gets the
 * same plan for an equivalent selection.
 */
export function resolveScanCleanupPageScope(
    pageNumbers: readonly number[] | undefined,
    documentPageCount: number,
): number[] {
    const requested = pageNumbers === undefined
        ? Array.from({length: documentPageCount}, (_, index) => index + 1)
        : [...pageNumbers];
    if (requested.length === 0) {
        throw new ScanCleanupPageScopeError(
            'Scan cleanup source page scope must not be empty',
            requested,
            documentPageCount,
        );
    }
    const seen = new Set<number>();
    for (const pageNumber of requested) {
        if (!Number.isSafeInteger(pageNumber) || pageNumber <= 0) {
            throw new ScanCleanupPageScopeError(
                'Scan cleanup source page scope requires strictly positive integers',
                requested,
                documentPageCount,
            );
        }
        if (pageNumber > documentPageCount) {
            throw new ScanCleanupPageScopeError(
                'Scan cleanup source page scope is outside the document',
                requested,
                documentPageCount,
            );
        }
        if (seen.has(pageNumber)) {
            throw new ScanCleanupPageScopeError(
                `Scan cleanup source page scope contains duplicate page ${String(pageNumber)}`,
                requested,
                documentPageCount,
            );
        }
        seen.add(pageNumber);
    }
    return requested.sort((left, right) => left - right);
}
