import {
    type H3Event,
    getHeader,
    getRequestIP,
    getRequestURL,
} from 'h3';
import {
    ANALYTICS_HASH_SECRET_MIN_LENGTH,
    createDailyAnalyticsVisitorHash,
    resolveAnalyticsClientIp,
    resolveStrongAnalyticsSecret,
} from '@contracts/analyticsPrivacy';
import { normalizeAnalyticsGeo } from '@contracts/analytics';

export const LANDING_ANALYTICS_ADMISSION_REJECTED_SQLSTATE = 'EVB01';
export const LANDING_ANALYTICS_BODY_MAX_BYTES = 8 * 1024;
export const LANDING_ANALYTICS_HASH_SECRET_MIN_LENGTH = ANALYTICS_HASH_SECRET_MIN_LENGTH;
export const LANDING_ANALYTICS_USER_AGENT_MAX_LENGTH = 512;

export const LANDING_ANALYTICS_ADMISSION_DEFAULTS = Object.freeze({
    bucketSeconds: 300,
    dedupeSeconds: 10,
    downloadGlobalEventLimit: 500,
    downloadVisitorEventLimit: 8,
    pageViewGlobalEventLimit: 3_000,
    pageViewVisitorEventLimit: 30,
});

type TLandingAnalyticsSurface = 'download' | 'page_view';
type TAnalyticsEnvironment = Record<string, string | undefined>;

interface ILandingAnalyticsAdmissionPolicy {
    bucketSeconds: number;
    dedupeSeconds: number;
    globalEventLimit: number;
    visitorEventLimit: number;
}

interface IGeoData {
    country: string | null
    city: string | null
    region: string | null
}

function firstNonEmptyString(values: Array<string | undefined>) {
    for (const value of values) {
        const normalized = value?.trim();
        if (normalized) {
            return normalized;
        }
    }
    return '';
}

function isTruthyFlag(value: unknown) {
    return value === true
        || value === 1
        || value === '1'
        || value === 'true';
}

function normalizeAllowedHosts(value: string) {
    return value
        .split(',')
        .map(entry => entry.trim().toLowerCase())
        .filter(Boolean);
}

function resolveLandingAnalyticsHashSecret(env: TAnalyticsEnvironment) {
    return resolveStrongAnalyticsSecret([
        env.NUXT_LANDING_ANALYTICS_HASH_SECRET,
        env.LANDING_ANALYTICS_HASH_SECRET,
    ]);
}

function resolveBoundedInteger(
    value: string,
    fallback: number,
    min: number,
    max: number,
) {
    if (!/^\d+$/u.test(value)) {
        return fallback;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function isLandingAnalyticsWriteAllowed(
    event: H3Event,
    env: TAnalyticsEnvironment = process.env,
) {
    return isLandingAnalyticsWriteAllowedForHost(
        env,
        getRequestURL(event).host,
    );
}

export function isLandingAnalyticsWriteAllowedForHost(
    env: TAnalyticsEnvironment,
    requestHost: string,
) {
    const writeEnabled = firstNonEmptyString([
        env.NUXT_LANDING_ANALYTICS_WRITE_ENABLED,
        env.LANDING_ANALYTICS_WRITE_ENABLED,
        env.NUXT_ANALYTICS_WRITE_ENABLED,
        env.ANALYTICS_WRITE_ENABLED,
    ]);
    if (!isTruthyFlag(writeEnabled)) {
        return false;
    }

    if (!resolveLandingAnalyticsHashSecret(env)) {
        return false;
    }

    const allowedHosts = normalizeAllowedHosts(firstNonEmptyString([
        env.NUXT_LANDING_ANALYTICS_ALLOWED_HOSTS,
        env.LANDING_ANALYTICS_ALLOWED_HOSTS,
        env.NUXT_ANALYTICS_ALLOWED_HOSTS,
        env.ANALYTICS_ALLOWED_HOSTS,
    ]));
    if (allowedHosts.length === 0) {
        return true;
    }
    return allowedHosts.includes(requestHost.trim().toLowerCase());
}

export function isTrustedLandingAnalyticsRequestValues(input: {
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

export function isTrustedLandingAnalyticsRequest(event: H3Event) {
    return isTrustedLandingAnalyticsRequestValues({
        contentType: getHeader(event, 'content-type'),
        fetchSite: getHeader(event, 'sec-fetch-site'),
        origin: getHeader(event, 'origin'),
        requestOrigin: getRequestURL(event).origin,
    });
}

export function resolveLandingAnalyticsAdmissionPolicy(
    surface: TLandingAnalyticsSurface,
    env: TAnalyticsEnvironment = process.env,
): ILandingAnalyticsAdmissionPolicy {
    const prefix = surface === 'download' ? 'DOWNLOAD' : 'PAGE_VIEW';
    const defaultVisitorLimit = surface === 'download'
        ? LANDING_ANALYTICS_ADMISSION_DEFAULTS.downloadVisitorEventLimit
        : LANDING_ANALYTICS_ADMISSION_DEFAULTS.pageViewVisitorEventLimit;
    const defaultGlobalLimit = surface === 'download'
        ? LANDING_ANALYTICS_ADMISSION_DEFAULTS.downloadGlobalEventLimit
        : LANDING_ANALYTICS_ADMISSION_DEFAULTS.pageViewGlobalEventLimit;
    return {
        bucketSeconds: resolveBoundedInteger(
            firstNonEmptyString([
                env.NUXT_LANDING_ANALYTICS_BUCKET_SECONDS,
                env.LANDING_ANALYTICS_BUCKET_SECONDS,
            ]),
            LANDING_ANALYTICS_ADMISSION_DEFAULTS.bucketSeconds,
            60,
            3_600,
        ),
        dedupeSeconds: resolveBoundedInteger(
            firstNonEmptyString([
                env.NUXT_LANDING_ANALYTICS_DEDUPE_SECONDS,
                env.LANDING_ANALYTICS_DEDUPE_SECONDS,
            ]),
            LANDING_ANALYTICS_ADMISSION_DEFAULTS.dedupeSeconds,
            2,
            120,
        ),
        globalEventLimit: resolveBoundedInteger(
            firstNonEmptyString([
                env[`NUXT_LANDING_ANALYTICS_${prefix}_GLOBAL_LIMIT`],
                env[`LANDING_ANALYTICS_${prefix}_GLOBAL_LIMIT`],
            ]),
            defaultGlobalLimit,
            50,
            20_000,
        ),
        visitorEventLimit: resolveBoundedInteger(
            firstNonEmptyString([
                env[`NUXT_LANDING_ANALYTICS_${prefix}_VISITOR_LIMIT`],
                env[`LANDING_ANALYTICS_${prefix}_VISITOR_LIMIT`],
            ]),
            defaultVisitorLimit,
            1,
            300,
        ),
    };
}

export function isLandingAnalyticsAdmissionRejected(error: unknown) {
    const visited = new Set<unknown>();
    let current: unknown = error;
    while (isRecord(current) && !visited.has(current)) {
        visited.add(current);
        if (current.code === LANDING_ANALYTICS_ADMISSION_REJECTED_SQLSTATE) {
            return true;
        }
        current = current.sourceError ?? current.cause;
    }
    return false;
}

export function extractGeo(event: H3Event): IGeoData {
    const geo = normalizeAnalyticsGeo({
        country: getHeader(event, 'x-vercel-ip-country') ?? null,
        city: getHeader(event, 'x-vercel-ip-city') ?? null,
        region: getHeader(event, 'x-vercel-ip-country-region') ?? null,
    });
    return {
        country: geo.country,
        city: geo.city,
        region: geo.region,
    };
}

export async function getAnalyticsRequestContext(
    event: H3Event,
    env: TAnalyticsEnvironment = process.env,
) {
    return {
        geo: extractGeo(event),
        visitorHash: await hashVisitorIdentity(event, env),
        userAgent: getHeader(event, 'user-agent')?.slice(0, LANDING_ANALYTICS_USER_AGENT_MAX_LENGTH) ?? null,
    };
}

export async function createLandingAnalyticsDedupeKey(
    surface: TLandingAnalyticsSurface,
    visitorHash: string,
    payload: unknown,
) {
    const bytes = new TextEncoder().encode(`${surface}:${visitorHash}:${JSON.stringify(payload)}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

export async function createLandingAnalyticsVisitorHash(input: {
    date: string
    ip: string
    secret: string
}) {
    return createDailyAnalyticsVisitorHash(input);
}

export async function hashVisitorIdentity(
    event: H3Event,
    env: TAnalyticsEnvironment = process.env,
) {
    const ip = resolveAnalyticsClientIp({
        isVercel: env.VERCEL === '1',
        platformIp: getRequestIP(event),
        vercelForwardedFor: getHeader(event, 'x-vercel-forwarded-for'),
    });
    return createLandingAnalyticsVisitorHash({
        date: new Date().toISOString().slice(0, 10),
        ip,
        secret: resolveLandingAnalyticsHashSecret(env),
    });
}
