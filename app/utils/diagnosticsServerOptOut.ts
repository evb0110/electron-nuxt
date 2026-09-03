import {
    DIAGNOSTICS_SERVER_OPT_IN_COOKIE_VALUE,
    DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_MAX_AGE_SECONDS,
    DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_NAME,
    DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_VALUE,
    parseDiagnosticsServerOptOutCookie,
    type TServerDiagnosticsObjection,
} from '@contracts/diagnostics/serverDiagnosticsObjection';

export type TDiagnosticsServerOptOut = TServerDiagnosticsObjection['diagnosticsServerOptOut'];

function getSecureCookieAttribute() {
    try {
        const runtimeMeta = import.meta as ImportMeta & {env?: {PROD?: boolean}};
        return runtimeMeta.env?.PROD === true
            || (typeof location !== 'undefined' && location.protocol === 'https:')
            ? '; Secure'
            : '';
    } catch {
        return '';
    }
}

function readCookieValue() {
    if (typeof document === 'undefined') {
        return null;
    }

    try {
        for (const item of document.cookie.split(';')) {
            const separatorIndex = item.indexOf('=');
            if (separatorIndex < 0 || item.slice(0, separatorIndex).trim() !== DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_NAME) {
                continue;
            }
            return item.slice(separatorIndex + 1).trim();
        }
    } catch {
        return null;
    }
    return null;
}

export function readDiagnosticsServerOptOut(): TDiagnosticsServerOptOut {
    return parseDiagnosticsServerOptOutCookie(readCookieValue());
}

export function writeDiagnosticsServerOptOut(optedOut: TDiagnosticsServerOptOut): boolean {
    if (typeof document === 'undefined') {
        return false;
    }

    const value = optedOut
        ? DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_VALUE
        : DIAGNOSTICS_SERVER_OPT_IN_COOKIE_VALUE;
    try {
        document.cookie = `${DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_NAME}=${value}; Path=/; Max-Age=${DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${getSecureCookieAttribute()}`;
        return true;
    } catch {
        return false;
    }
}
