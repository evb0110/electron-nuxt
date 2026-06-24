import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    onHeadersReceived: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
}));

vi.mock('electron', () => ({session: {defaultSession: {
    setPermissionRequestHandler: mocks.setPermissionRequestHandler,
    webRequest: {onHeadersReceived: mocks.onHeadersReceived},
}}}));
vi.mock('@electron/config', () => ({config: {isDev: false}}));

const {
    buildContentSecurityPolicy,
    setupContentSecurityPolicy,
} = await import('@electron/security/csp');

function parseCsp(csp: string) {
    return Object.fromEntries(csp.split('; ').map((directive) => {
        const [
            name,
            ...tokens
        ] = directive.split(' ');
        return [
            name,
            tokens,
        ];
    }));
}

describe('buildContentSecurityPolicy', () => {
    it('allows inline scripts in development policy for Nuxt bootstrap/HMR', () => {
        const directives = parseCsp(buildContentSecurityPolicy(true));

        expect(directives).toEqual({
            'base-uri': ['\'self\''],
            'connect-src': [
                '\'self\'',
                'ws:',
                'blob:',
            ],
            'default-src': ['\'self\''],
            'font-src': [
                '\'self\'',
                'data:',
            ],
            'form-action': ['\'self\''],
            'frame-ancestors': ['\'none\''],
            'img-src': [
                '\'self\'',
                'data:',
                'blob:',
            ],
            'object-src': ['\'none\''],
            'script-src': [
                '\'self\'',
                '\'unsafe-inline\'',
                '\'wasm-unsafe-eval\'',
            ],
            'script-src-attr': ['\'none\''],
            'style-src': [
                '\'self\'',
                '\'unsafe-inline\'',
            ],
            'worker-src': [
                '\'self\'',
                'blob:',
            ],
        });
    });

    it('allows inline script elements and WASM eval in production for Nuxt SPA bootstrap and pdf.js workers', () => {
        const directives = parseCsp(buildContentSecurityPolicy(false));

        // 'wasm-unsafe-eval' is intentionally enabled in production: pdf.js's
        // renderer WebWorker compiles bundled WASM (jbig2/openjpeg/qcms/quickjs)
        // for JBIG2/JPEG2000 images, ICC profiles, and embedded JS actions.
        expect(directives).toEqual({
            'base-uri': ['\'self\''],
            'connect-src': [
                '\'self\'',
                'blob:',
            ],
            'default-src': ['\'self\''],
            'font-src': [
                '\'self\'',
                'data:',
            ],
            'form-action': ['\'self\''],
            'frame-ancestors': ['\'none\''],
            'img-src': [
                '\'self\'',
                'data:',
                'blob:',
            ],
            'object-src': ['\'none\''],
            'script-src': [
                '\'self\'',
                '\'unsafe-inline\'',
                '\'wasm-unsafe-eval\'',
            ],
            'script-src-attr': ['\'none\''],
            'style-src': [
                '\'self\'',
                '\'unsafe-inline\'',
            ],
            'worker-src': [
                '\'self\'',
                'blob:',
            ],
        });
    });

    it('denies runtime permission prompts by default', () => {
        setupContentSecurityPolicy();

        const handler = mocks.setPermissionRequestHandler.mock.calls[0]?.[0];
        expect(handler).toBeTypeOf('function');
        const callback = vi.fn();
        handler?.({}, 'media', callback, {});

        expect(callback).toHaveBeenCalledWith(false);
    });
});
