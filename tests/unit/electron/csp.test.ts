import {
    mkdtempSync,
    rmSync,
    writeFileSync,
    mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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
vi.mock('@electron/config', () => ({config: {
    isDev: false,
    renderer: {staticRoot: '/missing/nuxt-output/public'},
}}));

const {
    buildContentSecurityPolicy,
    collectProductionInlineScriptCspHashes,
    createInlineScriptCspHash,
    extractInlineScriptCspHashes,
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

    it('allows only hashed inline script elements and WASM eval in production', () => {
        const bootstrapHash = createInlineScriptCspHash('window.__NUXT__={};');
        const directives = parseCsp(buildContentSecurityPolicy(
            false,
            {inlineScriptHashes: [
                bootstrapHash,
                'not-a-csp-hash',
            ]},
        ));

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
                bootstrapHash,
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

    it('extracts deterministic CSP hashes from inline script elements only', () => {
        const html = [
            '<script src="/_nuxt/app.js"></script>',
            '<script>window.__NUXT__={};</script>',
            '<script type="application/json">{"payload":true}</script>',
            '<script>window.__NUXT__={};</script>',
        ].join('');
        const expectedPayloadHash = `'sha256-${createHash('sha256')
            .update('{"payload":true}', 'utf8')
            .digest('base64')}'`;

        expect(extractInlineScriptCspHashes(html)).toEqual([
            expectedPayloadHash,
            createInlineScriptCspHash('window.__NUXT__={};'),
        ].sort());
    });

    it('collects production hashes from the Electron Nuxt entrypoint artifact', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-csp-test-'));
        try {
            mkdirSync(join(tempRoot, 'electron'), {recursive: true});
            writeFileSync(
                join(tempRoot, 'electron', 'index.html'),
                '<script>globalThis.__NUXT__={serverRendered:false};</script>',
            );

            const staticBootstrapHash = createInlineScriptCspHash('globalThis.__NUXT__={serverRendered:false};');

            expect(collectProductionInlineScriptCspHashes(tempRoot)).toEqual([staticBootstrapHash]);
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
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
