import {fileURLToPath} from 'node:url';
import {
    DEFAULT_LOCALE,
    LOCALE_DEFINITIONS,
} from './packages/i18n-core';

function isInvalidNuxtUiResizableImport(entry: unknown) {
    if (!entry || typeof entry !== 'object') {
        return false;
    }

    const from = Reflect.get(entry, 'from');
    const name = Reflect.get(entry, 'name');
    return typeof name === 'string'
        && typeof from === 'string'
        && name === 'options'
        && from.includes('@nuxt/ui/dist/runtime/composables/useResizable');
}

function isLegacyElectronShimImport(entry: unknown) {
    if (!entry || typeof entry !== 'object') {
        return false;
    }

    const from = Reflect.get(entry, 'from');
    return typeof from === 'string'
        && (
            from === '<repo-root>/app/utils/electron'
            || from === '<repo-root>/app/utils/electron.ts'
            || from.endsWith('/app/utils/electron')
            || from.endsWith('/app/utils/electron.ts')
        );
}

const nitroOutputDir = process.env.VERCEL === '1' || process.env.NOW_BUILDER === '1'
    ? '.vercel/output'
    : 'nuxt-output';
const nitroOutputPublicDir = `${nitroOutputDir}/public`;
const nitroOutputServerDir = `${nitroOutputDir}/server`;

const isDev = process.env.NODE_ENV !== 'production';
const appShellCacheHeaders = {
    'cache-control': 'no-store, max-age=0, must-revalidate',
    'pragma': 'no-cache',
    'expires': '0',
} as const;
const appDir = fileURLToPath(new URL('./app', import.meta.url));
const knownSourcemapWarningPlugins = new Set([
    '@tailwindcss/vite:generate:build',
    'nuxt:module-preload-polyfill',
    'nuxt:server-devonly:transform',
]);

interface IRollupLog {
    code?: string | undefined;
    message: string;
    plugin?: string | undefined;
}

function isKnownSourcemapWarning(log: IRollupLog) {
    if (log.code !== 'SOURCEMAP_BROKEN') {
        return false;
    }

    const plugin = log.plugin ?? log.message?.match(/a plugin \(([^)]+)\)/u)?.[1];
    return plugin ? knownSourcemapWarningPlugins.has(plugin) : false;
}

export default defineNuxtConfig({
    app: {
        head: {
            meta: [
                { charset: 'utf-8' },
                { name: 'viewport', content: 'width=device-width, initial-scale=1' },
                { name: 'theme-color', content: '#ffffff', media: '(prefers-color-scheme: light)' },
                { name: 'theme-color', content: '#1a1a1a', media: '(prefers-color-scheme: dark)' },
                { name: 'format-detection', content: 'telephone=no' },
            ],
            link: [
                {
                    rel: 'icon',
                    type: 'image/png',
                    sizes: '16x16',
                    href: isDev ? '/favicon-dev-16x16.png' : '/favicon-16x16.png?v=5',
                },
                {
                    rel: 'icon',
                    type: 'image/png',
                    sizes: '32x32',
                    href: isDev ? '/favicon-dev-32x32.png' : '/favicon-32x32.png?v=5',
                },
                {
                    rel: 'icon',
                    type: 'image/svg+xml',
                    href: isDev ? '/favicon-dev.svg' : '/favicon.svg?v=5',
                },
                {
                    rel: 'icon',
                    type: 'image/x-icon',
                    href: isDev ? '/favicon-dev.ico' : '/favicon.ico?v=5',
                },
                {
                    rel: 'apple-touch-icon',
                    sizes: '180x180',
                    href: '/apple-touch-icon.png',
                },
            ],
            style: [{
                key: 'app-shell-critical',
                children: `
html, body, #__nuxt { min-height: 100%; }
:root {
    --app-font-ui: 'EVB Noto Sans', Arial, 'Helvetica Neue', Helvetica, system-ui, sans-serif;
    --ui-primary: var(--ui-color-primary-700);
    --ui-bg: #ffffff;
    --ui-bg-elevated: var(--ui-color-neutral-50);
    --ui-bg-muted: var(--ui-color-neutral-100);
    --ui-text: var(--ui-color-neutral-900);
    --ui-text-dimmed: var(--ui-color-neutral-500);
    --ui-border: var(--ui-color-neutral-200);
    --ui-bg-inverted: var(--ui-color-neutral-950);
    --app-window-bg: var(--ui-bg);
    --app-chrome: color-mix(in oklab, var(--ui-bg) 35%, var(--ui-border) 65%);
    --app-chrome-hover: color-mix(in oklab, var(--ui-bg) 55%, var(--ui-border) 45%);
    --app-toolbar-control-hover-bg: var(--app-chrome-hover);
    --app-toolbar-control-active-bg: #ffffff;
    --app-toolbar-control-active-hover-bg: #ffffff;
    --app-toolbar-control-disabled-fg: color-mix(in oklab, var(--ui-text-dimmed) 88%, var(--ui-border) 12%);
    --app-toolbar-control-disabled-opacity: 0.4;
    --app-editor-pane-grid-bg: var(--app-window-bg);
    --app-editor-sash-size: 6px;
    --app-editor-sash-bg: color-mix(in oklab, var(--ui-border) 68%, transparent);
    --shadow-popup: 0 6px 18px rgb(0 0 0 / 0.12), 0 2px 6px rgb(0 0 0 / 0.06);
}
.dark {
    --ui-primary: var(--ui-color-primary-400);
    --ui-bg: var(--ui-color-neutral-900);
    --ui-bg-elevated: var(--ui-color-neutral-800);
    --ui-bg-muted: var(--ui-color-neutral-800);
    --ui-text: var(--ui-color-neutral-50);
    --ui-text-dimmed: var(--ui-color-neutral-400);
    --ui-border: var(--ui-color-neutral-700);
    --ui-bg-inverted: var(--ui-color-neutral-50);
    --app-window-bg: var(--ui-bg);
    --app-chrome: color-mix(in oklab, var(--ui-bg) 35%, var(--ui-border) 65%);
    --app-chrome-hover: color-mix(in oklab, var(--ui-bg) 60%, var(--ui-border) 40%);
    --app-toolbar-control-hover-bg: var(--app-chrome-hover);
    --app-toolbar-control-active-bg: color-mix(in oklab, var(--ui-bg) 60%, var(--ui-text) 6%);
    --app-toolbar-control-active-hover-bg: color-mix(in oklab, var(--ui-bg) 50%, var(--ui-text) 9%);
    --app-toolbar-control-disabled-fg: color-mix(in oklab, var(--ui-text-dimmed) 86%, var(--ui-border) 14%);
    --app-toolbar-control-disabled-opacity: 0.38;
    --app-editor-pane-grid-bg: var(--app-window-bg);
    --app-editor-sash-bg: color-mix(in oklab, var(--ui-border) 80%, transparent);
    --shadow-popup: 0 10px 24px rgb(0 0 0 / 0.3), 0 3px 8px rgb(0 0 0 / 0.2);
}
html { background: var(--app-window-bg); color: var(--ui-text); font-family: var(--app-font-ui); }
body { margin: 0; background: var(--app-window-bg); color: var(--ui-text); font-family: inherit; }
*, *::before, *::after { box-sizing: border-box; }
.app-shell-root {
    min-height: 100vh;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--app-window-bg);
}
.app-shell-root > .flex-1,
.editor-pane,
.editor-pane-content,
.editor-split,
.editor-split-pane,
.workspace-host,
.workspace-host__placeholder {
    min-width: 0;
    min-height: 0;
}
.app-shell-root > .flex-1,
.editor-pane-content,
.editor-split-pane {
    flex: 1 1 auto;
}
.browser-install-hint {
    position: fixed;
    top: 0.75rem;
    right: 1rem;
    z-index: 35;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.35rem;
    border: 1px solid var(--ui-border);
    border-radius: 999px;
    background: color-mix(in oklab, var(--ui-bg) 92%, transparent);
    box-shadow: var(--shadow-popup);
}
.browser-install-link,
.browser-install-dismiss {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 1.75rem;
    padding: 0.25rem 0.5rem;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--ui-text);
    font: inherit;
    text-decoration: none;
}
.browser-install-divider {
    width: 1px;
    height: 1rem;
    background: var(--ui-border);
}
.editor-global-toolbar-shell,
.editor-global-toolbar-host {
    flex: 0 0 auto;
    min-height: 3.25rem;
}
.toolbar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-height: 3.25rem;
    padding: 0.5rem;
    border-bottom: 1px solid var(--ui-border);
    background: var(--app-chrome);
    white-space: nowrap;
    overflow: hidden;
    --toolbar-control-height: 2.25rem;
}
.toolbar-section,
.toolbar-inline-group,
.toolbar-button-group,
.toolbar-group-item,
.tab-list {
    display: flex;
    align-items: center;
    min-width: 0;
}
.toolbar-section { gap: 0.25rem; }
.toolbar-center {
    flex: 1 1 auto;
    justify-content: center;
    min-width: 0;
}
.toolbar-right {
    flex: 0 0 auto;
    margin-left: auto;
}
.toolbar-separator {
    width: 1px;
    height: 1.5rem;
    flex: 0 0 auto;
    background: var(--ui-border);
}
.toolbar-btn,
.tab-close,
.tab-new {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--toolbar-control-height, 2.25rem);
    height: var(--toolbar-control-height, 2.25rem);
    padding: 0.25rem;
    border: 1px solid transparent;
    border-radius: 0.25rem;
    background: transparent;
    color: var(--ui-text);
    font: inherit;
}
.tab-bar {
    display: flex;
    align-items: stretch;
    min-height: 2.5rem;
    border-bottom: 1px solid var(--ui-border);
    background: var(--app-chrome);
    overflow: hidden;
}
.tab-list {
    flex: 1 1 auto;
    min-width: 0;
}
.tab {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    max-width: 18rem;
    padding: 0 0.5rem 0 0.75rem;
    border-right: 1px solid var(--ui-border);
}
.tab-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.editor-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--app-window-bg);
}
.editor-pane-content {
    display: flex;
    overflow: hidden;
}
.editor-pane-content > * {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
}
.editor-split {
    display: flex;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--app-editor-pane-grid-bg);
}
.editor-split.is-horizontal { flex-direction: row; }
.editor-split.is-vertical { flex-direction: column; }
.editor-sash {
    flex-shrink: 0;
    background: var(--app-editor-sash-bg);
}
.editor-sash.is-vertical-line { width: var(--app-editor-sash-size); }
.editor-sash.is-horizontal-line { height: var(--app-editor-sash-size); }
.empty-state {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem 1rem;
    overflow: auto;
}
.empty-state-content,
.recent-files {
    width: min(100%, 40rem);
}
.recent-files {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}
.recent-files-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
}
.recent-files-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
}
.recent-file-item,
.open-file-row {
    display: grid;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--ui-border);
    border-radius: 0.75rem;
    background: var(--ui-bg);
}
.recent-file-item { grid-template-columns: auto minmax(0, 1fr) auto auto; }
.open-file-row {
    grid-template-columns: auto minmax(0, 1fr);
    background: transparent;
    text-align: left;
}
.recent-file-name,
.recent-file-path,
.recent-file-time,
.open-file-row-label,
.empty-state-hint,
.empty-state-subhint {
    display: block;
    min-width: 0;
}
.recent-file-name,
.recent-file-path,
.open-file-row-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.recent-file-path,
.recent-file-time,
.empty-state-hint,
.empty-state-subhint {
    color: var(--ui-text-dimmed);
}
                `,
            } as any],
        },
    },

    modules: [
        '@nuxt/eslint',
        '@nuxt/ui',
        '@nuxt/icon',
        '@nuxtjs/i18n',
    ],

    components: [
        {
            path: '~/components',
            pathPrefix: false,
        },
        {
            path: '~/modules/workspace-shell/components',
            pathPrefix: false,
            extensions: ['vue'],
        },
    ],

    css: [
        '~/assets/css/main.css',
    ],

    // Keep Nuxt's server renderer available for prerender/build-time output and
    // Nitro endpoints. Personalized browser state is client-seeded, not
    // request-time SSR-rendered.
    ssr: true,

    // Disable SPA loading template - causes jerky size changes due to scrollbar appearance
    spaLoadingTemplate: false,

    devtools: {enabled: false},

    devServer: {port: 3235},

    ignore: [
        'resources/djvulibre/**',
        'resources/poppler/**',
        'resources/qpdf/**',
        'resources/tesseract/**',
    ],

    colorMode: {
        preference: 'light',
        storage: 'cookie',
        disableTransition: true,
    },

    hooks: {
        // Nuxt UI's scanner can leak a non-exported `options` symbol from useResizable into #imports.
        // Removing it here prevents runtime ESM import errors during app bootstrap.
        'imports:extend': (imports) => {
            for (let index = imports.length - 1; index >= 0; index -= 1) {
                if (
                    isInvalidNuxtUiResizableImport(imports[index])
                    || isLegacyElectronShimImport(imports[index])
                ) {
                    imports.splice(index, 1);
                }
            }
        },
    },

    alias: {
        '@app': appDir,
        '@contracts': fileURLToPath(new URL('./packages/contracts', import.meta.url)),
        '@pdf-core': fileURLToPath(new URL('./packages/pdf-core', import.meta.url)),
        '@i18n-core': fileURLToPath(new URL('./packages/i18n-core', import.meta.url)),
        '@i18n-app': fileURLToPath(new URL('./packages/i18n-app', import.meta.url)),
        '@releaseSelection': fileURLToPath(new URL('./packages/release-selection', import.meta.url)),
        '@server': fileURLToPath(new URL('./server', import.meta.url)),
    },

    runtimeConfig: {
        analytics: {
            // Keep writes explicitly opt-in so local dev and preview traffic
            // never hits the production analytics dataset by accident.
            databaseUrl: process.env.NUXT_ANALYTICS_DATABASE_URL || process.env.ANALYTICS_DATABASE_URL || process.env.DATABASE_URL || '',
            writeEnabled: process.env.NUXT_ANALYTICS_WRITE_ENABLED === '1' || process.env.ANALYTICS_WRITE_ENABLED === '1',
            allowedHosts: (process.env.NUXT_ANALYTICS_ALLOWED_HOSTS || process.env.ANALYTICS_ALLOWED_HOSTS || '')
                .split(',')
                .map(host => host.trim())
                .filter(Boolean),
        },
        public: {
            analyticsEnabled: process.env.NUXT_PUBLIC_ANALYTICS_ENABLED === '1',
            landingUrl: process.env.NUXT_PUBLIC_LANDING_URL || 'https://evb-viewer.vercel.app',
            siteUrl: process.env.NUXT_PUBLIC_SITE_URL || 'https://evb-viewer-web.vercel.app',
        },
    },

    routeRules: {
        '/robots.txt': { prerender: true },
        '/sitemap.xml': { prerender: true },
        '/electron': {
            prerender: true,
            ssr: false,
            headers: {
                ...appShellCacheHeaders,
                'X-Robots-Tag': 'noindex, nofollow',
            },
        },
        '/electron/**': {
            prerender: true,
            ssr: false,
            headers: {
                ...appShellCacheHeaders,
                'X-Robots-Tag': 'noindex, nofollow',
            },
        },
        '/': {
            prerender: true,
            headers: appShellCacheHeaders,
        },
        '/_payload.json': {
            headers: appShellCacheHeaders,
        },
        '/**/_payload.json': {
            headers: appShellCacheHeaders,
        },
        '/_nuxt/builds/**': {
            headers: appShellCacheHeaders,
        },
        '/workspace': {
            // Compatibility entry only. Keep the browser workspace SSR/SSG surface
            // canonical at `/` so refresh does not hit a SPA-only shell.
            redirect: { to: '/', statusCode: 302 },
            headers: {
                ...appShellCacheHeaders,
                'X-Robots-Tag': 'noindex, nofollow',
            },
        },
        '/mobile-reader-proof': {
            prerender: true,
            headers: appShellCacheHeaders,
        },
        '/api/analytics/events': {
            prerender: false,
        },
        '/**': {
            headers: {
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'strict-origin-when-cross-origin',
                'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
            },
        },
    },

    sourcemap: {
        server: false,
        client: false,
    },

    i18n: {
        restructureDir: 'app',
        locales: LOCALE_DEFINITIONS,
        defaultLocale: DEFAULT_LOCALE,
        baseUrl: process.env.NUXT_PUBLIC_SITE_URL || 'https://evb-viewer-web.vercel.app',
        lazy: true,
        langDir: 'i18n/runtime-locales/',
        strategy: 'no_prefix',
        detectBrowserLanguage: {
            useCookie: true,
            cookieKey: 'i18n_redirected',
            redirectOn: 'root',
        },
    },

    icon: {
        serverBundle: {collections: ['ph']},
        clientBundle: {icons: [
            'ph:arrow-down',
            'ph:arrow-left',
            'ph:arrow-right',
            'ph:arrow-up',
            'ph:text-b',
            'ph:book-open',
            'ph:bookmark',
            'ph:check',
            'ph:caret-down',
            'ph:caret-left',
            'ph:caret-right',
            'ph:caret-up',
            'ph:caret-double-down',
            'ph:caret-double-left',
            'ph:caret-double-right',
            'ph:caret-double-up',
            'ph:warning-circle',
            'ph:check-circle',
            'ph:stop-circle',
            'ph:x-circle',
            'ph:clock',
            'ph:scan',
            'ph:text-aa',
            'ph:copy',
            'ph:stack-plus',
            'ph:crop',
            'ph:dots-three',
            'ph:arrow-square-out',
            'ph:eye',
            'ph:eye-slash',
            'ph:file',
            'ph:file-plus',
            'ph:file-text',
            'ph:files',
            'ph:folder',
            'ph:folder-open',
            'ph:globe',
            'ph:hand',
            'ph:hard-drive',
            'ph:hash',
            'ph:highlighter',
            'ph:image',
            'ph:image',
            'ph:images',
            'ph:info',
            'ph:text-italic',
            'ph:squares-four',
            'ph:lightbulb',
            'ph:list',
            'ph:circle-notch',
            'ph:circle-notch',
            'ph:list',
            'ph:rows',
            'ph:tree-view',
            'ph:crosshair-simple',
            'ph:chat-circle',
            'ph:chat',
            'ph:chat-circle-dots',
            'ph:monitor',
            'ph:download-simple',
            'ph:moon',
            'ph:arrows-out-line-horizontal',
            'ph:arrows-out-line-vertical',
            'ph:sidebar-simple',
            'ph:sidebar-simple',
            'ph:sidebar-simple',
            'ph:pen-nib',
            'ph:plus',
            'ph:pencil',
            'ph:printer',
            'ph:pencil-simple-line',
            'ph:dots-six-vertical',
            'ph:arrows-clockwise',
            'ph:floppy-disk',
            'ph:floppy-disk-back',
            'ph:magnifying-glass',
            'ph:magnifying-glass',
            'ph:scroll',
            'ph:sun',
            'ph:star',
            'ph:cursor-text',
            'ph:trash',
            'ph:text-t',
            'ph:warning',
            'ph:arrow-u-up-left',
            'ph:upload',
            'ph:user',
            'ph:x',
            'ph:magnifying-glass-plus',
            'ph:scan',
            'ph:play',
            'ph:warning-circle',
            'ph:check-circle',
            'ph:arrows-out',
            'ph:clock',
            'ph:magic-wand',
            'ph:arrow-u-up-right',
            'ph:text-underline',
            'ph:text-strikethrough',
            'ph:waves',
            'ph:square',
            'ph:circle',
            'ph:clipboard-text',
            'ph:minus',
            'ph:arrow-up-right',
            'ph:stamp',
            'ph:gear',
            'ph:sliders-horizontal',
            'ph:note',
            'ph:sticker',
            'ph:translate',
            'circle-flags:gb',
            'circle-flags:ru',
            'circle-flags:fr',
            'circle-flags:de',
            'circle-flags:es',
            'circle-flags:it',
            'circle-flags:pt',
            'circle-flags:nl',
            'ph:export',
            'ph:file-arrow-down',
            'ph:file-plus',
            'ph:link-simple',
            'ph:arrow-clockwise',
            'ph:arrow-counter-clockwise',
            'ph:corners-out',
            'ph:corners-in',
        ]},
    },

    vite: {
        css: {
            preprocessorOptions: {
                scss: {
                    additionalData: '@use "~/assets/css/transitions" as *;\n',
                },
            },
        },
        build: {
            sourcemap: false,
            // Electron desktop bundle tolerates larger chunks, but still split heavy vendors to keep rebuilds snappier.
            chunkSizeWarningLimit: 1400,
            rollupOptions: {
                onLog(level, log, handler) {
                    if (level === 'warn' && isKnownSourcemapWarning(log)) {
                        return;
                    }

                    handler(level, log);
                },
                output: {manualChunks: {
                    'vendor-pdfjs': [
                        'pdfjs-dist',
                        'pdfjs-dist/web/pdf_viewer.mjs',
                    ],
                    'vendor-pdf-lib': ['pdf-lib'],
                    'vendor-vueuse': [
                        '@vueuse/core',
                        '@vueuse/math',
                    ],
                }},
            },
        },
        optimizeDeps: {
            include: [
                '@vueuse/core',
                '@vueuse/math',
                'devalue',
                'unhead',
                '@unhead/vue',
                'vue-router',
                'ofetch',
                'hookable',
                'unctx',
                'klona',
                'destr',
                'scule',
                '@vue/devtools-api',
                '@iconify/vue',
            ],
            exclude: ['pdfjs-dist'],
        },
        server: {
            watch: {usePolling: false},
            warmup: {
                // Pre-transform the initial route/module graph to reduce Electron cold-start blank time in dev.
                clientFiles: [
                    `${appDir}/app.vue`,
                    `${appDir}/pages/index.vue`,
                    `${appDir}/composables/useSettings.ts`,
                    `${appDir}/composables/useTypedI18n.ts`,
                ],
            },
        },
    },

    nitro: {
        sourceMap: false,
        // Vercel's Nuxt builder only recognizes Build Output API artifacts from
        // `.vercel/output`; local desktop flows still consume `nuxt-output`.
        output: {
            dir: nitroOutputDir,
            publicDir: nitroOutputPublicDir,
            serverDir: nitroOutputServerDir,
        },
        prerender: {
            routes: [
                '/',
                '/electron',
                '/workspace',
                '/mobile-reader-proof',
                '/robots.txt',
                '/sitemap.xml',
            ],
        },
    },

    compatibilityDate: '2025-01-01',
});
