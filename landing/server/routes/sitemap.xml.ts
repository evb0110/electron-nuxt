import {
    buildAbsoluteUrl,
    LANDING_ROUTE_PATHS,
    normalizeSiteUrl,
} from '~~/shared/seo';

const BUILD_TIMESTAMP = new Date().toISOString();

export default defineEventHandler((event) => {
    const runtimeConfig = useRuntimeConfig(event);
    const siteUrl = normalizeSiteUrl(runtimeConfig.public.siteUrl);
    const imageUrl = buildAbsoluteUrl(siteUrl, '/evb-viewer-preview.png');

    const urlEntries = LANDING_ROUTE_PATHS.map((path) => {
        const location = buildAbsoluteUrl(siteUrl, path);

        const imageEntry = path === '/'
            ? `\n    <image:image>\n      <image:loc>${imageUrl}</image:loc>\n      <image:title>EVB Viewer — cross-platform document viewer</image:title>\n    </image:image>`
            : '';

        return [
            '  <url>',
            `    <loc>${location}</loc>`,
            `    <lastmod>${BUILD_TIMESTAMP}</lastmod>${imageEntry}`,
            '  </url>',
        ].join('\n');
    }).join('\n');

    const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
        '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
        urlEntries,
        '</urlset>',
    ].join('\n');

    setHeader(event, 'content-type', 'application/xml; charset=utf-8');
    return `${xml}\n`;
});
