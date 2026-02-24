import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

vi.mock('electron', () => ({session: {defaultSession: {webRequest: {onHeadersReceived: vi.fn()}}}}));
vi.mock('@electron/config', () => ({config: {isDev: false}}));

const { buildContentSecurityPolicy } = await import('@electron/security/csp');

describe('buildContentSecurityPolicy', () => {
    it('allows inline scripts in development policy for Nuxt bootstrap/HMR', () => {
        const csp = buildContentSecurityPolicy(true);

        expect(csp).toContain('script-src \'self\' \'unsafe-inline\' \'wasm-unsafe-eval\'');
        expect(csp).toContain('connect-src \'self\' ws: blob:');
        expect(csp).toContain('script-src-attr \'none\'');
    });

    it('uses self-only connect/script sources in production policy', () => {
        const csp = buildContentSecurityPolicy(false);

        expect(csp).toContain('script-src \'self\'');
        expect(csp).toContain('connect-src \'self\' blob:');
        expect(csp).not.toContain('wasm-unsafe-eval');
    });
});
