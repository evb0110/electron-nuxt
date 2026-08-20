export const ANALYTICS_HASH_SECRET_MIN_LENGTH = 32;

export function resolveStrongAnalyticsSecret(values: ReadonlyArray<string | undefined>) {
    for (const value of values) {
        const normalized = value?.trim();
        if (!normalized) {
            continue;
        }

        // Fail closed on the highest-priority configured value. Falling back
        // would hide a weak production override behind a lower-priority secret.
        return normalized.length >= ANALYTICS_HASH_SECRET_MIN_LENGTH ? normalized : '';
    }

    return '';
}

export function resolveAnalyticsClientIp(input: {
    isVercel: boolean
    platformIp: string | undefined
    vercelForwardedFor: string | undefined
}) {
    if (input.isVercel) {
        const forwardedIp = input.vercelForwardedFor
            ?.split(',', 1)[0]
            ?.trim();
        if (forwardedIp) {
            return forwardedIp;
        }
    }

    const platformIp = input.platformIp?.trim();
    if (platformIp) {
        return platformIp;
    }

    return 'unknown';
}

export async function createDailyAnalyticsVisitorHash(input: {
    date: string
    ip: string
    secret: string
}) {
    if (input.secret.length < ANALYTICS_HASH_SECRET_MIN_LENGTH) {
        throw new Error('Analytics hash secret is not configured securely');
    }

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(input.secret),
        {
            hash: 'SHA-256',
            name: 'HMAC',
        },
        false,
        ['sign'],
    );
    const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(`${input.date}:${input.ip}`),
    );
    return Array.from(new Uint8Array(signature))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}
