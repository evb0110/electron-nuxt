/** The purpose-specific first-party cookie used to object to viewer Nitro diagnostics. */
export const DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_NAME = 'diagnosticsServerOptOut' as const;
export const DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_VALUE = '1' as const;
export const DIAGNOSTICS_SERVER_OPT_IN_COOKIE_VALUE = '0' as const;
export const DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_MAX_AGE_SECONDS = 31_536_000;

export interface IServerDiagnosticsObjectionPreference {readonly diagnosticsServerOptOut: boolean;}

export type TServerDiagnosticsObjection = IServerDiagnosticsObjectionPreference;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    try {
        const prototype = Reflect.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
}

export function parseDiagnosticsServerOptOutCookie(value: unknown): boolean {
    return value === DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_VALUE;
}

export function decodeServerDiagnosticsObjection(
    value: unknown,
): IServerDiagnosticsObjectionPreference | null {
    if (!isPlainRecord(value)) {
        return null;
    }
    try {
        const keys = Reflect.ownKeys(value);
        if (
            keys.length !== 1
            || keys[0] !== 'diagnosticsServerOptOut'
            || typeof value.diagnosticsServerOptOut !== 'boolean'
        ) {
            return null;
        }
        return createServerDiagnosticsObjectionPreference(value.diagnosticsServerOptOut);
    } catch {
        return null;
    }
}

export function createServerDiagnosticsObjectionPreference(
    diagnosticsServerOptOut: boolean,
): IServerDiagnosticsObjectionPreference {
    return Object.freeze({diagnosticsServerOptOut});
}
