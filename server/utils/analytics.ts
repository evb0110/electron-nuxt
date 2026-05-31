import {
    type H3Event,
    getHeader,
    getRequestIP,
    getRequestURL,
} from 'h3';
import { compact } from 'es-toolkit/array';
import { getRuntimeEnv } from '@server/utils/runtimeEnv';

interface IGeoData {
    country: string | null;
    city: string | null;
    region: string | null;
}

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

export function extractGeo(event: H3Event): IGeoData {
    return {
        country: getHeader(event, 'x-vercel-ip-country') ?? null,
        city: getHeader(event, 'x-vercel-ip-city') ?? null,
        region: getHeader(event, 'x-vercel-ip-country-region') ?? null,
    };
}

export function getAnalyticsRequestHost(event: H3Event): string {
    return getRequestURL(event).host.trim().toLowerCase();
}

export async function hashVisitorIdentity(event: H3Event): Promise<string> {
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

export function isAnalyticsWriteAllowed(event: H3Event): boolean {
    void event;
    const env = getRuntimeEnv();

    const writeEnabled = env.NUXT_ANALYTICS_WRITE_ENABLED
        || env.ANALYTICS_WRITE_ENABLED
        || '';
    if (!isTruthyFlag(writeEnabled)) {
        return false;
    }

    const allowedHosts = normalizeAllowedHosts(
        env.NUXT_ANALYTICS_ALLOWED_HOSTS
        || env.ANALYTICS_ALLOWED_HOSTS
        || '',
    );
    if (allowedHosts.length === 0) {
        return true;
    }

    return allowedHosts.includes(getAnalyticsRequestHost(event));
}
