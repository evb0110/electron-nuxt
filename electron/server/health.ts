import {
    getRuntimeIdentityUrl,
    isTrustedRuntimeIdentityPayload,
} from '@contracts/runtime-identity';

export async function isServerRunning(
    serverUrl: string,
    timeoutMs: number,
) {
    try {
        const response = await fetch(serverUrl, {
            method: 'HEAD',
            signal: AbortSignal.timeout(timeoutMs),
        });
        return response.ok;
    } catch {
        return false;
    }
}

export async function isTrustedRuntimeServer(
    serverUrl: string,
    timeoutMs: number,
) {
    try {
        const response = await fetch(getRuntimeIdentityUrl(serverUrl), {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
            return false;
        }

        const payload = await response.json();
        return isTrustedRuntimeIdentityPayload(payload);
    } catch {
        return false;
    }
}
