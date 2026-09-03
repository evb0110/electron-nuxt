import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createServerDiagnosticsObjectionPreference,
    decodeServerDiagnosticsObjection,
    DIAGNOSTICS_SERVER_OPT_IN_COOKIE_VALUE,
    DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_NAME,
    DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_VALUE,
    parseDiagnosticsServerOptOutCookie,
} from '@contracts/diagnostics/serverDiagnosticsObjection';

describe('server diagnostics objection contract', () => {
    it('uses one purpose-specific boolean cookie value', () => {
        expect(DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_NAME).toBe('diagnosticsServerOptOut');
        expect(DIAGNOSTICS_SERVER_OPT_OUT_COOKIE_VALUE).toBe('1');
        expect(DIAGNOSTICS_SERVER_OPT_IN_COOKIE_VALUE).toBe('0');
        expect(parseDiagnosticsServerOptOutCookie('1')).toBe(true);
        expect(parseDiagnosticsServerOptOutCookie('0')).toBe(false);
        expect(parseDiagnosticsServerOptOutCookie(undefined)).toBe(false);
        expect(parseDiagnosticsServerOptOutCookie('true')).toBe(false);
    });

    it('decodes only the closed boolean preference and no identifier', () => {
        const decoded = decodeServerDiagnosticsObjection({diagnosticsServerOptOut: true});
        expect(decoded).toEqual({diagnosticsServerOptOut: true});
        expect(Object.isFrozen(decoded)).toBe(true);
        expect(decodeServerDiagnosticsObjection({
            diagnosticsServerOptOut: true,
            diagnosticId: 'stable-id-must-not-exist',
        })).toBeNull();
        expect(decodeServerDiagnosticsObjection(true)).toBeNull();
    });

    it('creates a frozen preference for either direction', () => {
        expect(createServerDiagnosticsObjectionPreference(false)).toEqual({diagnosticsServerOptOut: false});
        expect(Object.isFrozen(createServerDiagnosticsObjectionPreference(false))).toBe(true);
    });
});
