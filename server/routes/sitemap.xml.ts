import {
    defineEventHandler,
    setHeader,
} from 'h3';
import { resolveSiteUrl } from '../utils/normalize-site-url';

const BUILD_TIMESTAMP = new Date().toISOString();

export default defineEventHandler((event) => {
    const siteUrl = resolveSiteUrl(event);
    const loc = new URL('/', siteUrl).toString();
    const imageUrl = new URL('/evb-viewer-preview-cropped.png', siteUrl).toString();

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>${loc}</loc>
    <lastmod>${BUILD_TIMESTAMP}</lastmod>
    <image:image>
      <image:loc>${imageUrl}</image:loc>
      <image:title>EVB Viewer Web — browser document workspace</image:title>
    </image:image>
  </url>
</urlset>
`;

    setHeader(event, 'content-type', 'application/xml; charset=utf-8');
    return xml;
});
