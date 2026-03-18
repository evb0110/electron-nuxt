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

    const updatedAt = new Date().toISOString();
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${new URL('/', siteUrl).toString()}</loc>
    <lastmod>${updatedAt}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;

    setHeader(event, 'content-type', 'application/xml; charset=utf-8');
    return xml;
});
