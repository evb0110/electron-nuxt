import {fileURLToPath} from 'node:url';

import {
    DEFAULT_LOCALE,
    LOCALE_CODES,
    LOCALE_DEFINITIONS,
} from './app/i18n/core';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
    modules: [
        '@nuxt/ui',
        '@nuxtjs/i18n',
        '@nuxtjs/sitemap',
    ],

    devtools: { enabled: true },

    css: ['~/assets/css/main.css'],

    alias: {
        '@i18n-core': fileURLToPath(new URL('./app/i18n/core.ts', import.meta.url)),
        '@releaseSelection': fileURLToPath(new URL('../packages/release-selection', import.meta.url)),
    },

    runtimeConfig: {
        databaseUrl: process.env.DATABASE_URL,
        githubApiBase: process.env.NUXT_GITHUB_API_BASE || 'https://api.github.com',
        githubOwner: process.env.NUXT_GITHUB_OWNER || 'evb0110',
        githubRepo: process.env.NUXT_GITHUB_REPO || 'evb-viewer',
        githubToken: process.env.NUXT_GITHUB_TOKEN || '',
        public: {
            siteUrl: process.env.NUXT_PUBLIC_SITE_URL || process.env.NUXT_SITE_URL || 'https://evb-viewer.vercel.app',
            webAppUrl: process.env.NUXT_PUBLIC_WEB_APP_URL || 'https://evb-viewer-web.vercel.app',
        },
    },

    routeRules: {
        '/': { isr: 600 },
        '/features': { prerender: true },
        '/docs': { prerender: true },
        ...Object.fromEntries(
            LOCALE_CODES
                .filter(code => code !== DEFAULT_LOCALE)
                .flatMap(code => [
                    [`/${code}`, { isr: 600 }],
                    [`/${code}/features`, { prerender: true }],
                    [`/${code}/docs`, { prerender: true }],
                ]),
        ),
        '/robots.txt': { prerender: true },
    },

    sitemap: {
        autoI18n: true,
        xslColumns: [
            { label: 'URL', width: '65%' },
            { label: 'Last Modified', select: 'sitemap:lastmod', width: '35%' },
        ],
    },

    i18n: {
        restructureDir: 'app',
        locales: LOCALE_DEFINITIONS.map(locale => ({ ...locale })),
        defaultLocale: DEFAULT_LOCALE,
        baseUrl: process.env.NUXT_PUBLIC_SITE_URL || process.env.NUXT_SITE_URL || 'https://evb-viewer.vercel.app',
        langDir: 'locales/',
        strategy: 'prefix_except_default',
        detectBrowserLanguage: {
            useCookie: true,
            cookieKey: 'i18n_locale',
            redirectOn: 'root',
        },
    },

    icon: {clientBundle: {icons: [
        'ph:arrow-right',
        'ph:download',
        'ph:files',
        'ph:globe',
        'ph:folder-open',
        'ph:sidebar',
        'ph:list',
        'ph:pen-nib',
        'ph:scissors',
        'ph:text-aa',
        'circle-flags:gb',
        'circle-flags:ru',
        'circle-flags:fr',
        'circle-flags:de',
        'circle-flags:es',
        'circle-flags:it',
        'circle-flags:pt',
        'circle-flags:nl',
        'simple-icons:github',
    ]}},

    compatibilityDate: '2025-01-15',
});
