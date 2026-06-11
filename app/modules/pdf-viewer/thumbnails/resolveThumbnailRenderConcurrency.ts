interface IResolveThumbnailRenderConcurrencyOptions {
    baseConcurrency: number;
    lastNavigationAtMs: number;
    navigationCooldownMs: number;
    nowMs: number;
}

export function resolveThumbnailRenderConcurrency(
    options: IResolveThumbnailRenderConcurrencyOptions,
) {
    const baseConcurrency = Math.max(1, Math.trunc(options.baseConcurrency));
    const navigationAgeMs = options.nowMs - options.lastNavigationAtMs;
    if (
        Number.isFinite(navigationAgeMs)
        && navigationAgeMs >= 0
        && navigationAgeMs <= options.navigationCooldownMs
    ) {
        return 1;
    }
    return baseConcurrency;
}
