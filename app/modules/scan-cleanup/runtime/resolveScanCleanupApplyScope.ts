export type TScanCleanupApplyScope = 'all' | 'from-here' | 'selected' | 'every-other';

export interface IResolveScanCleanupApplyScopeOptions {
    leader: number;
    pageCount: number;
    selectedPages: ReadonlySet<number>;
}

export function resolveScanCleanupApplyScope(
    options: IResolveScanCleanupApplyScopeOptions,
    scope: TScanCleanupApplyScope,
): ReadonlySet<number> {
    const pageCount = Math.max(0, Math.floor(options.pageCount));
    if (pageCount === 0) {
        return new Set();
    }
    const leader = Math.min(pageCount, Math.max(1, Math.floor(options.leader)));
    const allPages = Array.from({length: pageCount}, (_, index) => index + 1);
    if (scope === 'from-here') {
        return new Set(allPages.slice(leader - 1));
    }
    if (scope === 'selected') {
        return new Set([...options.selectedPages]
            .filter(page => Number.isInteger(page) && page >= 1 && page <= pageCount)
            .sort((left, right) => left - right));
    }
    if (scope === 'every-other') {
        return new Set(allPages.filter(page => page % 2 === leader % 2));
    }
    return new Set(allPages);
}
