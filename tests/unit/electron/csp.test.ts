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

    it('allows inline script elements and WASM eval in production for Nuxt SPA bootstrap and pdf.js workers', () => {
        const csp = buildContentSecurityPolicy(false);

        // 'wasm-unsafe-eval' is intentionally enabled in production: pdf.js's
        // renderer WebWorker compiles bundled WASM (jbig2/openjpeg/qcms/quickjs)
        // for JBIG2/JPEG2000 images, ICC profiles, and embedded JS actions.
        expect(csp).toContain('script-src \'self\' \'unsafe-inline\' \'wasm-unsafe-eval\'');
        expect(csp).toContain('connect-src \'self\' blob:');
        expect(csp).toContain('script-src-attr \'none\'');
    });
});
