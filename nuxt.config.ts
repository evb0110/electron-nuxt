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

const isVercelBuildOutput = process.env.VERCEL === '1' || process.env.NOW_BUILDER === '1';
const nitroOutput = isVercelBuildOutput
    // Let Nitro's Vercel preset keep Build Output API directories as static/ and functions/.
    ? {dir: '.vercel/output'}
    : {
        dir: 'nuxt-output',
        publicDir: 'nuxt-output/public',
        serverDir: 'nuxt-output/server',
    };

const isDev = process.env.NODE_ENV !== 'production';
const isolatedNuxtBuildDir = process.env.EVB_NUXT_BUILD_DIR?.trim();
const isolatedNuxtViteCacheDir = process.env.EVB_NUXT_VITE_CACHE_DIR?.trim();
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
    ...(isolatedNuxtBuildDir ? {buildDir: isolatedNuxtBuildDir} : {}),

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
            path: '~/modules/pdf-viewer/components',
            pathPrefix: false,
            extensions: ['vue'],
        },
        {
            path: '~/modules/workspace-shell/components',
            pathPrefix: false,
            extensions: ['vue'],
        },
    ],

    css: [
        '~/assets/css/app-shell-critical.scss',
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
                if (isInvalidNuxtUiResizableImport(imports[index])) {
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
            landingUrl: process.env.NUXT_PUBLIC_LANDING_URL || 'https://evb-viewer.com',
            siteUrl: process.env.NUXT_PUBLIC_SITE_URL || 'https://web.evb-viewer.com',
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
        '/privacy': {
            prerender: true,
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
        baseUrl: process.env.NUXT_PUBLIC_SITE_URL || 'https://web.evb-viewer.com',
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
            'ph:caret-up-down',
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
            'ph:flag',
            'ph:folder',
            'ph:folder-open',
            'ph:gauge',
            'ph:globe',
            'ph:hand',
            'ph:hard-drive',
            'ph:hash',
            'ph:highlighter',
            'ph:image',
            'ph:images',
            'ph:info',
            'ph:text-italic',
            'ph:squares-four',
            'ph:lightbulb',
            'ph:lightning',
            'ph:list',
            'ph:circle-notch',
            'ph:rows',
            'ph:tree-view',
            'ph:crosshair-simple',
            'ph:chat-circle',
            'ph:chat',
            'ph:chat-circle-dots',
            'ph:sparkle',
            'ph:monitor',
            'ph:download-simple',
            'ph:moon',
            'ph:arrows-out-line-horizontal',
            'ph:arrows-out-line-vertical',
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
            'ph:play',
            'ph:arrows-out',
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
            'ph:arrow-line-right',
            'ph:square-split-horizontal',
            'ph:square-split-vertical',
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
            'circle-flags:br',
            'circle-flags:nl',
            'ph:export',
            'ph:file-arrow-down',
            'ph:link-simple',
            'ph:arrow-clockwise',
            'ph:arrow-counter-clockwise',
            'ph:corners-out',
            'ph:corners-in',
        ]},
    },

    vite: {
        ...(isolatedNuxtViteCacheDir ? {cacheDir: isolatedNuxtViteCacheDir} : {}),
        worker: {format: 'es'},
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
        output: nitroOutput,
        ...(isVercelBuildOutput ? {
            // Vercel's file tracer can omit modules re-exported only by this
            // package's barrel, which leaves the server function unable to boot.
            externals: {inline: ['@iconify/utils']},
        } : {}),
        prerender: {
            routes: [
                '/',
                '/electron',
                '/workspace',
                '/mobile-reader-proof',
                '/privacy',
                '/robots.txt',
                '/sitemap.xml',
            ],
        },
    },

    compatibilityDate: '2025-01-01',
});
