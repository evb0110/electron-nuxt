import {
    getCookie,
    setCookie,
    type H3Event,
} from 'h3';
import {
    createServerDiagnosticsObjectionPreference,
    DIAGNOSTICS_SERVER_OPT_IN_COOKIE_VALUE,
    DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_MAX_AGE_SECONDS,
    DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_NAME,
    DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_VALUE,
    parseDiagnosticsServerOptOutCookie,
    type IServerDiagnosticsObjectionPreference,
} from '@contracts/diagnostics/serverDiagnosticsObjection';
import { getRuntimeEnv } from '@server/utils/getRuntimeEnv';

type TCookieSerializeOptions = NonNullable<Parameters<typeof setCookie>[3]>;

export interface IServerDiagnosticsObjectionCookieOptions {readonly secure?: boolean;}

export function readDiagnosticsServerObjection(event: H3Event): IServerDiagnosticsObjectionPreference {
    try {
        return createServerDiagnosticsObjectionPreference(
            parseDiagnosticsServerOptOutCookie(getCookie(event, DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_NAME)),
        );
    } catch {
        // A malformed or unavailable objection read must not admit a request-associated event.
        return createServerDiagnosticsObjectionPreference(true);
    }
}

export function hasDiagnosticsServerObjection(event: H3Event): boolean {
    return readDiagnosticsServerObjection(event).diagnosticsServerOptOut;
}

export function getDiagnosticsServerObjectionCookieOptions(
    options: IServerDiagnosticsObjectionCookieOptions = {},
): TCookieSerializeOptions {
    const secure = options.secure ?? getRuntimeEnv().NODE_ENV === 'production';
    return {
        httpOnly: false,
        maxAge: DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_MAX_AGE_SECONDS,
        path: '/',
        sameSite: 'lax',
        secure,
    };
}

export function writeDiagnosticsServerObjection(
    event: H3Event,
    diagnosticsServerOptOut: boolean,
    options: IServerDiagnosticsObjectionCookieOptions = {},
) {
    const value = diagnosticsServerOptOut
        ? DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_VALUE
        : DIAGNOSTICS_SERVER_OPT_IN_COOKIE_VALUE;
    setCookie(
        event,
        DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_NAME,
        value,
        getDiagnosticsServerObjectionCookieOptions(options),
    );
}
