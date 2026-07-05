import { getErrorMessage } from '@electron/utils/error';

function isNativeFallbackDisallowedInTests(enabledEnvName: string) {
    return process.env.VITEST === 'true' && process.env[enabledEnvName] === '1';
}

export function createNativeFallbackTestError(
    enabledEnvName: string,
    label: string,
    detail: string,
    cause?: unknown,
) {
    if (!isNativeFallbackDisallowedInTests(enabledEnvName)) {
        return null;
    }

    const suffix = cause === undefined ? '' : `: ${getErrorMessage(cause)}`;
    const error = new Error(`${label} fallback is not allowed in tests: ${detail}${suffix}`);
    if (cause !== undefined) {
        Object.defineProperty(error, 'cause', {
            value: cause,
            enumerable: false,
            configurable: true,
            writable: true,
        });
    }
    return error;
}
