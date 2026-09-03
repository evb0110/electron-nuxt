import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_MAX_AGE_SECONDS,
    DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_NAME,
    parseDiagnosticsServerOptOutCookie,
} from '@contracts/diagnostics/serverDiagnosticsObjection';
import {
    readDiagnosticsServerOptOut,
    writeDiagnosticsServerOptOut,
} from '@app/utils/diagnosticsServerOptOut';

function stubBrowser(options: {
    cookie?: string;
    protocol?: 'http:' | 'https:';
} = {}) {
    const writes: string[] = [];
    vi.stubGlobal('location', {protocol: options.protocol ?? 'http:'});
    vi.stubGlobal('document', {
        get cookie() {
            return options.cookie ?? '';
        },
        set cookie(value: string) {
            writes.push(value);
        },
    });
    return writes;
}

describe('diagnosticsServerOptOut', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('accepts only the typed opt-out value', () => {
        expect(parseDiagnosticsServerOptOutCookie('1')).toBe(true);
        expect(parseDiagnosticsServerOptOutCookie('0')).toBe(false);
        expect(parseDiagnosticsServerOptOutCookie('true')).toBe(false);
        expect(parseDiagnosticsServerOptOutCookie(undefined)).toBe(false);
    });

    it('reads the first-party cookie without creating an identifier', () => {
        stubBrowser({cookie: `other=1; ${DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_NAME}=1`});

        expect(readDiagnosticsServerOptOut()).toBe(true);
    });

    it('writes a bounded lax cookie and adds Secure on HTTPS', () => {
        const writes = stubBrowser({protocol: 'https:'});

        expect(writeDiagnosticsServerOptOut(true)).toBe(true);
        expect(writes).toEqual([`${DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_NAME}=1; Path=/; Max-Age=${DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax; Secure`]);
        expect(writes[0]).not.toContain('id=');
        expect(DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 365);
    });

    it('writes an explicit opt-in value without coupling it to client consent', () => {
        const writes = stubBrowser();

        expect(writeDiagnosticsServerOptOut(false)).toBe(true);
        expect(writes[0]).toBe(`${DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_NAME}=0; Path=/; Max-Age=${DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`);
    });
});
