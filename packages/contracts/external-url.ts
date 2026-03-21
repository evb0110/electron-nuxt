import { assertNonEmptyString } from './ipc-assertions';

export const ALLOWED_EXTERNAL_PROTOCOLS = new Set([
    'http:',
    'https:',
    'mailto:',
]);

function tryParseUrl(value: string) {
    try {
        return new URL(value);
    } catch {
        return null;
    }
}

export function parseAllowedExternalUrl(rawUrl: string) {
    const normalized = rawUrl.trim();
    if (!normalized) {
        return null;
    }

    const parsed = tryParseUrl(normalized);
    if (!parsed || !ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
        return null;
    }

    return parsed;
}

export function normalizeAllowedExternalUrl(rawUrl: string) {
    return parseAllowedExternalUrl(rawUrl)?.toString() ?? null;
}

export function sanitizeAllowedExternalUrl(rawUrl: unknown) {
    const normalized = assertNonEmptyString(rawUrl, 'url');
    const allowedUrl = normalizeAllowedExternalUrl(normalized);
    if (allowedUrl) {
        return allowedUrl;
    }

    const parsed = tryParseUrl(normalized);
    if (parsed) {
        throw new Error(`Unsupported external URL protocol: ${parsed.protocol}`);
    }

    throw new Error('Invalid external URL');
}
