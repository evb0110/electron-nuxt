import {
    type H3Event,
    getRequestURL,
} from 'h3';
import { getRuntimeEnv } from '../utils/runtimeEnv';

export function normalizeSiteUrl(siteUrl: string) {
    return siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
}

export function resolveSiteUrl(event: H3Event): string {
    const requestUrl = getRequestURL(event);
    const env = getRuntimeEnv();
    const configuredSiteUrl = env.NUXT_PUBLIC_SITE_URL
        || env.SITE_URL
        || '';
    return normalizeSiteUrl(
        configuredSiteUrl || `${requestUrl.protocol}//${requestUrl.host}`,
    );
}
