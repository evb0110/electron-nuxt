import {
    HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX,
    decodeHostResourceProfileSnapshot,
} from '@contracts/hostResourceProfile';

const BASE64URL_PATTERN = /^[\w-]+$/u;

/**
 * Sandboxed Electron preloads expose a Buffer polyfill. That polyfill does
 * not promise Node's `base64url` encoding label, so keep the wire format
 * portable by translating it to ordinary base64 at this boundary.
 */
function decodeBase64Url(value: string) {
    const base64 = value
        .replace(/-/gu, '+')
        .replace(/_/gu, '/');
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    return Buffer.from(`${base64}${padding}`, 'base64');
}

function encodeBase64Url(value: Buffer) {
    return value
        .toString('base64')
        .replace(/\+/gu, '-')
        .replace(/\//gu, '_')
        .replace(/=+$/u, '');
}

export function readHostResourceProfileArgument(
    argv: readonly string[] = process.argv,
) {
    const matchingArguments = argv.filter(argument =>
        argument.startsWith(HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX),
    );
    if (matchingArguments.length !== 1) {
        return null;
    }

    const encodedSnapshot = matchingArguments[0]!.slice(
        HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX.length,
    );
    if (
        !BASE64URL_PATTERN.test(encodedSnapshot)
        || encodedSnapshot.length % 4 === 1
    ) {
        return null;
    }

    try {
        const decodedBuffer = decodeBase64Url(encodedSnapshot);
        if (encodeBase64Url(decodedBuffer) !== encodedSnapshot) {
            return null;
        }
        const parsed: unknown = JSON.parse(decodedBuffer.toString('utf8'));
        return decodeHostResourceProfileSnapshot(parsed);
    } catch {
        return null;
    }
}
