export type TPlatformUnsupportedReason =
    | 'unsupported-backend'
    | 'missing-browser-permission'
    | 'user-canceled'
    | 'not-implemented'
    | 'requires-native-backend';

export interface IPlatformUnsupportedResult {
    ok: false;
    reason: TPlatformUnsupportedReason;
    message?: string;
}

export interface IPlatformOkResult<T> {
    ok: true;
    value: T;
}

export type TPlatformResult<T> = IPlatformOkResult<T> | IPlatformUnsupportedResult;

export function createPlatformUnsupportedResult(
    reason: TPlatformUnsupportedReason,
    message?: string,
): IPlatformUnsupportedResult {
    return {
        ok: false,
        reason,
        ...(message === undefined ? {} : {message}),
    };
}
