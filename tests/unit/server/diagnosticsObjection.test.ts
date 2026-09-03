import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import {
    getDiagnosticsServerObjectionCookieOptions,
    hasDiagnosticsServerObjection,
    readDiagnosticsServerObjection,
    writeDiagnosticsServerObjection,
} from '@server/utils/diagnosticsObjection';

const mocks = vi.hoisted(() => ({
    env: {} as Record<string, string | undefined>,
    getCookie: vi.fn(),
    setCookie: vi.fn(),
}));

vi.mock('h3', () => ({
    getCookie: mocks.getCookie,
    setCookie: mocks.setCookie,
}));
vi.mock('@server/utils/getRuntimeEnv', () => ({getRuntimeEnv: () => mocks.env}));

describe('server diagnostics objection utility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.env = {};
        mocks.getCookie.mockReturnValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reads only the purpose-specific cookie boolean', () => {
        const event = {} as never;
        expect(hasDiagnosticsServerObjection(event)).toBe(false);
        mocks.getCookie.mockReturnValue('1');
        expect(readDiagnosticsServerObjection(event)).toEqual({diagnosticsServerOptOut: true});
        expect(mocks.getCookie).toHaveBeenCalledWith(event, 'diagnosticsServerOptOut');
        mocks.getCookie.mockReturnValue('true');
        expect(hasDiagnosticsServerObjection(event)).toBe(false);
    });

    it('fails closed when cookie access fails', () => {
        mocks.getCookie.mockImplementation(() => {
            throw new Error('cookie parser unavailable');
        });
        expect(hasDiagnosticsServerObjection({} as never)).toBe(true);
    });

    it('uses a persistent SameSite cookie and Secure only in production', () => {
        expect(getDiagnosticsServerObjectionCookieOptions({secure: false})).toEqual({
            httpOnly: false,
            maxAge: 31_536_000,
            path: '/',
            sameSite: 'lax',
            secure: false,
        });
        mocks.env = {NODE_ENV: 'production'};
        expect(getDiagnosticsServerObjectionCookieOptions()).toMatchObject({
            maxAge: 31_536_000,
            sameSite: 'lax',
            secure: true,
        });
    });

    it('writes only the boolean cookie value', () => {
        const event = {} as never;
        writeDiagnosticsServerObjection(event, true, {secure: true});
        expect(mocks.setCookie).toHaveBeenCalledWith(
            event,
            'diagnosticsServerOptOut',
            '1',
            expect.objectContaining({
                secure: true,
                sameSite: 'lax',
            }),
        );
        writeDiagnosticsServerObjection(event, false, {secure: false});
        expect(mocks.setCookie).toHaveBeenLastCalledWith(
            event,
            'diagnosticsServerOptOut',
            '0',
            expect.objectContaining({secure: false}),
        );
    });
});
