export function normalizeSiteUrl(siteUrl: string) {
    return siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
}

export function resolveSiteUrl(event: Parameters<typeof getRequestURL>[0]): string {
    const runtimeConfig = useRuntimeConfig(event);
    const requestUrl = getRequestURL(event);
    const configuredSiteUrl = typeof runtimeConfig.public.siteUrl === 'string'
        ? runtimeConfig.public.siteUrl.trim()
        : '';
    return normalizeSiteUrl(
        configuredSiteUrl || `${requestUrl.protocol}//${requestUrl.host}`,
    );
}
