import {fileURLToPath} from 'node:url';
import {
    DEFAULT_LOCALE,
    LOCALE_DEFINITIONS,
} from './packages/i18n-core';

interface IImportsContextEntry {
    from: string;
    name: string;
}

function isInvalidNuxtUiResizableImport(entry: IImportsContextEntry) {
    return entry.name === 'options'
        && entry.from.includes('@nuxt/ui/dist/runtime/composables/useResizable');
}

export default defineNuxtConfig({
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

    ssr: false,

    // Disable SPA loading template - causes jerky size changes due to scrollbar appearance
    spaLoadingTemplate: false,

    devtools: {enabled: false},

    devServer: {port: 3235},

    colorMode: {preference: 'light'},

    hooks: {
        // Nuxt UI's scanner can leak a non-exported `options` symbol from useResizable into #imports.
        // Removing it here prevents runtime ESM import errors during app bootstrap.
        'imports:extend': (imports) => {
            for (let index = imports.length - 1; index >= 0; index -= 1) {
                const entry = imports[index] as IImportsContextEntry | undefined;
                if (!entry || !isInvalidNuxtUiResizableImport(entry)) {
                    continue;
                }
                imports.splice(index, 1);
            }
        },
    },

    alias: {
        '@app': fileURLToPath(new URL('./app', import.meta.url)),
        '@contracts': fileURLToPath(new URL('./packages/contracts', import.meta.url)),
        '@i18n-core': fileURLToPath(new URL('./packages/i18n-core', import.meta.url)),
        '@i18n-app': fileURLToPath(new URL('./packages/i18n-app', import.meta.url)),
        '@release-selection': fileURLToPath(new URL('./packages/release-selection', import.meta.url)),
    },

    sourcemap: {
        server: false,
        client: false,
    },

    i18n: {
        restructureDir: 'app',
        locales: LOCALE_DEFINITIONS,
        defaultLocale: DEFAULT_LOCALE,
        lazy: true,
        langDir: 'locales/',
        strategy: 'no_prefix',
        detectBrowserLanguage: false,
    },

    icon: {
        serverBundle: {collections: ['lucide']},
        clientBundle: {icons: [
            'lucide:arrow-down',
            'lucide:arrow-left',
            'lucide:arrow-right',
            'lucide:arrow-up',
            'lucide:book-open',
            'lucide:bookmark',
            'lucide:check',
            'lucide:chevron-down',
            'lucide:chevron-left',
            'lucide:chevron-right',
            'lucide:chevron-up',
            'lucide:chevrons-down',
            'lucide:chevrons-left',
            'lucide:chevrons-right',
            'lucide:chevrons-up',
            'lucide:circle-alert',
            'lucide:circle-check',
            'lucide:circle-stop',
            'lucide:circle-x',
            'lucide:scan',
            'lucide:copy',
            'lucide:ellipsis',
            'lucide:external-link',
            'lucide:eye',
            'lucide:eye-off',
            'lucide:file',
            'lucide:file-text',
            'lucide:folder',
            'lucide:folder-open',
            'lucide:hand',
            'lucide:hash',
            'lucide:highlighter',
            'lucide:info',
            'lucide:layout-grid',
            'lucide:lightbulb',
            'lucide:list',
            'lucide:loader-2',
            'lucide:loader-circle',
            'lucide:menu',
            'lucide:message-circle',
            'lucide:message-square',
            'lucide:message-square-plus',
            'lucide:monitor',
            'lucide:moon',
            'lucide:move-horizontal',
            'lucide:move-vertical',
            'lucide:panel-left',
            'lucide:panel-right-close',
            'lucide:panel-right-open',
            'lucide:pen-tool',
            'lucide:plus',
            'lucide:pencil',
            'lucide:square-pen',
            'lucide:grip-vertical',
            'lucide:refresh-cw',
            'lucide:save',
            'lucide:save-all',
            'lucide:search',
            'lucide:search-x',
            'lucide:scroll',
            'lucide:sun',
            'lucide:text-cursor',
            'lucide:trash-2',
            'lucide:type',
            'lucide:triangle-alert',
            'lucide:undo-2',
            'lucide:upload',
            'lucide:user',
            'lucide:x',
            'lucide:zoom-in',
            'lucide:scan-text',
            'lucide:play',
            'lucide:alert-circle',
            'lucide:check-circle',
            'lucide:scaling',
            'lucide:clock',
            'lucide:wand-2',
            'lucide:redo-2',
            'lucide:underline',
            'lucide:strikethrough',
            'lucide:waves',
            'lucide:square',
            'lucide:circle',
            'lucide:minus',
            'lucide:arrow-up-right',
            'lucide:stamp',
            'lucide:settings',
            'lucide:sliders-horizontal',
            'lucide:sticky-note',
            'lucide:sticker',
            'lucide:languages',
            'circle-flags:gb',
            'circle-flags:ru',
            'circle-flags:fr',
            'circle-flags:de',
            'circle-flags:es',
            'circle-flags:it',
            'circle-flags:pt',
            'circle-flags:nl',
            'lucide:file-output',
            'lucide:file-plus',
            'lucide:rotate-cw',
            'lucide:rotate-ccw',
        ]},
    },

    vite: {
        build: {
            // Electron desktop bundle tolerates larger chunks, but still split heavy vendors to keep rebuilds snappier.
            chunkSizeWarningLimit: 1400,
            rollupOptions: {output: {manualChunks: {
                'vendor-pdfjs': [
                    'pdfjs-dist',
                    'pdfjs-dist/web/pdf_viewer.mjs',
                ],
                'vendor-pdf-lib': ['pdf-lib'],
                'vendor-vueuse': ['@vueuse/core'],
            }}},
        },
        optimizeDeps: {
            include: [
                '@vueuse/core',
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
                    './app/app.vue',
                    './app/pages/index.vue',
                    './app/composables/useSettings.ts',
                    './app/composables/useTypedI18n.ts',
                ],
            },
        },
    },

    nitro: {
        sourceMap: false,
        output: { dir: 'nuxt-output' },
    },

    compatibilityDate: '2025-01-01',
});
