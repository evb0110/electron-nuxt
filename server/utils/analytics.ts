import {
    type H3Event,
    getHeader,
    getRequestIP,
    getRequestURL,
} from 'h3';
import { compact } from 'es-toolkit/array';
import {
    normalizeAnalyticsGeo,
    type IAnalyticsGeoData,
} from '@contracts/analytics';
import { getRuntimeEnv } from '@server/utils/getRuntimeEnv';

function isTruthyFlag(value: unknown) {
    return value === true
        || value === 1
        || value === '1'
        || value === 'true';
}

function normalizeAllowedHosts(value: unknown) {
    if (typeof value === 'string') {
        return compact(value
            .split(',')
            .map(entry => entry.trim().toLowerCase()));
    }

    if (!Array.isArray(value)) {
        return [];
    }

    return compact(value.map(entry => typeof entry === 'string' ? entry.trim().toLowerCase() : ''));
}

function firstNonEmptyString(values: Array<string | undefined>) {
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }

    return '';
}

export function extractGeo(event: H3Event): IAnalyticsGeoData {
    return normalizeAnalyticsGeo({
        country: getHeader(event, 'x-vercel-ip-country') ?? null,
        city: getHeader(event, 'x-vercel-ip-city') ?? null,
        region: getHeader(event, 'x-vercel-ip-country-region') ?? null,
        timezone: getHeader(event, 'x-vercel-ip-timezone') ?? null,
    });
}

export function getAnalyticsRequestHost(event: H3Event) {
    return getRequestURL(event).host.trim().toLowerCase();
}

export async function hashVisitorIdentity(event: H3Event) {
    const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown';
    const ua = getHeader(event, 'user-agent') ?? '';
    const dailySalt = new Date().toISOString().slice(0, 10);

    const raw = `${ip}:${ua}:${dailySalt}`;
    const data = new TextEncoder().encode(raw);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

export function isAnalyticsWriteAllowed(event: H3Event) {
    void event;
    const env = getRuntimeEnv();

    const writeEnabled = firstNonEmptyString([
        env.NUXT_ANALYTICS_WRITE_ENABLED,
        env.ANALYTICS_WRITE_ENABLED,
    ]);
    if (!isTruthyFlag(writeEnabled)) {
        return false;
    }

    const allowedHosts = normalizeAllowedHosts(
        firstNonEmptyString([
            env.NUXT_ANALYTICS_ALLOWED_HOSTS,
            env.ANALYTICS_ALLOWED_HOSTS,
        ]),
    );
    if (allowedHosts.length === 0) {
        return true;
    }

    return allowedHosts.includes(getAnalyticsRequestHost(event));
}
