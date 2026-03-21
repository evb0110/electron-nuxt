import {
    type H3Event,
    getRequestURL,
} from 'h3';

export function normalizeSiteUrl(siteUrl: string) {
    return siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
}

export function resolveSiteUrl(event: H3Event): string {
    const requestUrl = getRequestURL(event);
    const configuredSiteUrl = process.env.NUXT_PUBLIC_SITE_URL
        || process.env.SITE_URL
        || '';
    return normalizeSiteUrl(
        configuredSiteUrl || `${requestUrl.protocol}//${requestUrl.host}`,
    );
}
