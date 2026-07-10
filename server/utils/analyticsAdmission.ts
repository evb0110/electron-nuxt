import { isRecord } from '@contracts/runtimeGuards';

export const ANALYTICS_ADMISSION_REJECTED_SQLSTATE = 'EVB01';
export const ROOT_ANALYTICS_BODY_MAX_BYTES = 64 * 1024;
export const ROOT_ANALYTICS_MAX_EVENT_COUNT = 20;
export const ROOT_ANALYTICS_USER_AGENT_MAX_LENGTH = 512;

export const ROOT_ANALYTICS_ADMISSION_DEFAULTS = Object.freeze({
    bucketSeconds: 300,
    dedupeSeconds: 10,
    globalEventLimit: 10_000,
    visitorEventLimit: 120,
});

interface IAnalyticsAdmissionPolicy {
    bucketSeconds: number;
    dedupeSeconds: number;
    globalEventLimit: number;
    visitorEventLimit: number;
}

type TAnalyticsEnvironment = Record<string, string | undefined>;

function firstNonEmptyString(values: Array<string | undefined>) {
    for (const value of values) {
        const normalized = value?.trim();
        if (normalized) {
            return normalized;
        }
    }
    return '';
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

export function resolveRootAnalyticsAdmissionPolicy(
    env: TAnalyticsEnvironment,
): IAnalyticsAdmissionPolicy {
    return {
        bucketSeconds: resolveBoundedInteger(
            firstNonEmptyString([
                env.NUXT_ANALYTICS_BUCKET_SECONDS,
                env.ANALYTICS_BUCKET_SECONDS,
            ]),
            ROOT_ANALYTICS_ADMISSION_DEFAULTS.bucketSeconds,
            60,
            3_600,
        ),
        dedupeSeconds: resolveBoundedInteger(
            firstNonEmptyString([
                env.NUXT_ANALYTICS_DEDUPE_SECONDS,
                env.ANALYTICS_DEDUPE_SECONDS,
            ]),
            ROOT_ANALYTICS_ADMISSION_DEFAULTS.dedupeSeconds,
            2,
            120,
        ),
        globalEventLimit: resolveBoundedInteger(
            firstNonEmptyString([
                env.NUXT_ANALYTICS_GLOBAL_EVENT_LIMIT,
                env.ANALYTICS_GLOBAL_EVENT_LIMIT,
            ]),
            ROOT_ANALYTICS_ADMISSION_DEFAULTS.globalEventLimit,
            100,
            50_000,
        ),
        visitorEventLimit: resolveBoundedInteger(
            firstNonEmptyString([
                env.NUXT_ANALYTICS_VISITOR_EVENT_LIMIT,
                env.ANALYTICS_VISITOR_EVENT_LIMIT,
            ]),
            ROOT_ANALYTICS_ADMISSION_DEFAULTS.visitorEventLimit,
            1,
            600,
        ),
    };
}

export function isAnalyticsAdmissionRejected(error: unknown) {
    const visited = new Set<unknown>();
    let current: unknown = error;
    while (isRecord(current) && !visited.has(current)) {
        visited.add(current);
        if (current.code === ANALYTICS_ADMISSION_REJECTED_SQLSTATE) {
            return true;
        }
        current = current.sourceError ?? current.cause;
    }
    return false;
}

export async function createAnalyticsDedupeKey(
    surface: string,
    visitorHash: string,
    payload: unknown,
) {
    const bytes = new TextEncoder().encode(`${surface}:${visitorHash}:${JSON.stringify(payload)}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}
