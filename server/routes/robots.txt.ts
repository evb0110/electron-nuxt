function normalizeSiteUrl(siteUrl: string) {
    return siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
}

export default defineEventHandler((event) => {
    const runtimeConfig = useRuntimeConfig(event);
    const requestUrl = getRequestURL(event);
    const configuredSiteUrl = typeof runtimeConfig.public.siteUrl === 'string'
        ? runtimeConfig.public.siteUrl.trim()
        : '';
    const siteUrl = normalizeSiteUrl(
        configuredSiteUrl || `${requestUrl.protocol}//${requestUrl.host}`,
    );

    setHeader(event, 'content-type', 'text/plain; charset=utf-8');

    return [
        'User-agent: *',
        'Allow: /',
        `Sitemap: ${new URL('/sitemap.xml', siteUrl).toString()}`,
        '',
    ].join('\n');
});
