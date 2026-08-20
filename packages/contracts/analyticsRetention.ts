export const ANALYTICS_RETENTION_CRON_SECRET_MIN_LENGTH = 32;
export const ANALYTICS_RETENTION_MAX_BATCHES = 10;

export function parseAnalyticsRetentionCount(value: unknown) {
    if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
        throw new Error('Analytics retention purge returned an invalid row count');
    }
    return BigInt(value);
}

function constantTimeEqual(left: string, right: string) {
    if (left.length !== right.length) {
        return false;
    }
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
        difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
}

export function isAnalyticsRetentionRequestAuthorized(
    authorization: string | undefined,
    cronSecret: string | undefined,
) {
    if (
        !authorization
        || !cronSecret
        || cronSecret.length < ANALYTICS_RETENTION_CRON_SECRET_MIN_LENGTH
    ) {
        return false;
    }
    return constantTimeEqual(authorization, `Bearer ${cronSecret}`);
}
