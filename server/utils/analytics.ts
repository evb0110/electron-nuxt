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
import {
    ANALYTICS_HASH_SECRET_MIN_LENGTH,
    createDailyAnalyticsVisitorHash,
    resolveAnalyticsClientIp,
    resolveStrongAnalyticsSecret,
} from '@contracts/analyticsPrivacy';
import { getRuntimeEnv } from '@server/utils/getRuntimeEnv';

export { ANALYTICS_HASH_SECRET_MIN_LENGTH };

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

function resolveAnalyticsHashSecret(env: Record<string, string | undefined>) {
    return resolveStrongAnalyticsSecret([
        env.NUXT_ANALYTICS_HASH_SECRET,
        env.ANALYTICS_HASH_SECRET,
    ]);
}

export function isAnalyticsWriteAllowedForHost(
    env: Record<string, string | undefined>,
    requestHost: string,
) {
    const writeEnabled = firstNonEmptyString([
        env.NUXT_ANALYTICS_WRITE_ENABLED,
        env.ANALYTICS_WRITE_ENABLED,
    ]);
    if (!isTruthyFlag(writeEnabled)) {
        return false;
    }
    if (!resolveAnalyticsHashSecret(env)) {
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
    return allowedHosts.includes(requestHost.trim().toLowerCase());
}

export function isTrustedAnalyticsRequestValues(input: {
    contentType: string | undefined
    fetchSite: string | undefined
    origin: string | undefined
    requestOrigin: string | undefined
}) {
    if (input.contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return false;
    }
    if (input.fetchSite?.toLowerCase() !== 'same-origin') {
        return false;
    }
    if (!input.origin || !input.requestOrigin) {
        return false;
    }
    try {
        return new URL(input.origin).origin === new URL(input.requestOrigin).origin;
    } catch {
        return false;
    }
}

export function isTrustedAnalyticsRequest(event: H3Event) {
    return isTrustedAnalyticsRequestValues({
        contentType: getHeader(event, 'content-type'),
        fetchSite: getHeader(event, 'sec-fetch-site'),
        origin: getHeader(event, 'origin'),
        requestOrigin: getRequestURL(event).origin,
    });
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

export async function createAnalyticsVisitorHash(input: {
    date: string
    ip: string
    secret: string
}) {
    return createDailyAnalyticsVisitorHash(input);
}

export async function hashVisitorIdentity(
    event: H3Event,
    env: Record<string, string | undefined> = getRuntimeEnv(),
) {
    const ip = resolveAnalyticsClientIp({
        isVercel: env.VERCEL === '1',
        platformIp: getRequestIP(event),
        vercelForwardedFor: getHeader(event, 'x-vercel-forwarded-for'),
    });
    return createAnalyticsVisitorHash({
        date: new Date().toISOString().slice(0, 10),
        ip,
        secret: resolveAnalyticsHashSecret(env),
    });
}

export function isAnalyticsWriteAllowed(event: H3Event) {
    const env = getRuntimeEnv();
    return isAnalyticsWriteAllowedForHost(env, getAnalyticsRequestHost(event));
}
