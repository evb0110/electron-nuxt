export const EVB_RUNTIME_IDENTITY = Object.freeze({
    app: 'evb-viewer',
    runtime: 'nuxt-electron',
    version: 1 as const,
});

export interface IRuntimeIdentityPayload {
    app: typeof EVB_RUNTIME_IDENTITY.app;
    runtime: typeof EVB_RUNTIME_IDENTITY.runtime;
    version: typeof EVB_RUNTIME_IDENTITY.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function getRuntimeIdentityUrl(serverUrl: string) {
    return new URL('/api/runtime/identity', serverUrl).toString();
}

export function isTrustedRuntimeIdentityPayload(value: unknown): value is IRuntimeIdentityPayload {
    if (!isRecord(value)) {
        return false;
    }

    return (
        value.app === EVB_RUNTIME_IDENTITY.app
        && value.runtime === EVB_RUNTIME_IDENTITY.runtime
        && value.version === EVB_RUNTIME_IDENTITY.version
    );
}
