import {fileURLToPath} from 'node:url';

import {defineNuxtConfig as defineNuxtConfigBase} from 'nuxt/config';

import {
    DEFAULT_LOCALE,
    LOCALE_CODES,
    LOCALE_DEFINITIONS,
} from './vendor/i18n-core';

// Nuxt 4.4.7's config declaration currently loses the helper call signature.
const defineNuxtConfig = defineNuxtConfigBase as <T extends Record<string, unknown>>(config: T) => T;

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
    modules: [
        '@nuxt/eslint',
        '@nuxt/ui',
        '@nuxtjs/i18n',
        '@nuxtjs/sitemap',
    ],

    devtools: { enabled: true },

    devServer: { port: 3777 },

    typescript: { tsConfig: { compilerOptions: {
        strict: true,
        exactOptionalPropertyTypes: true,
        noImplicitReturns: true,
        noFallthroughCasesInSwitch: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        useUnknownInCatchVariables: true,
        strictBuiltinIteratorReturn: true,
        verbatimModuleSyntax: true,
        moduleDetection: 'force',
        isolatedModules: true,
        forceConsistentCasingInFileNames: true,
        skipLibCheck: true,
    } } },

    css: ['~/assets/css/main.css'],

    alias: {
        '@contracts': fileURLToPath(new URL('./vendor/contracts', import.meta.url)),
        '@i18n-core': fileURLToPath(new URL('./vendor/i18n-core', import.meta.url)),
        '@releaseSelection': fileURLToPath(new URL('./vendor/release-selection', import.meta.url)),
    },

    runtimeConfig: {
        databaseUrl: process.env.DATABASE_URL,
        githubApiBase: process.env.NUXT_GITHUB_API_BASE || 'https://api.github.com',
        githubOwner: process.env.NUXT_GITHUB_OWNER || 'evb0110',
        githubRepo: process.env.NUXT_GITHUB_REPO || 'evb-viewer',
        githubToken: process.env.NUXT_GITHUB_TOKEN || '',
        releaseStableTags: process.env.NUXT_RELEASE_STABLE_TAGS || '',
        releaseWithdrawnTags: process.env.NUXT_RELEASE_WITHDRAWN_TAGS || '',
        releaseCanaryTag: process.env.NUXT_RELEASE_CANARY_TAG || '',
        releaseCanaryPercent: process.env.NUXT_RELEASE_CANARY_PERCENT || '0',
        public: {
            siteUrl: process.env.NUXT_PUBLIC_SITE_URL || process.env.NUXT_SITE_URL || 'https://evb-viewer.com',
            webAppUrl: process.env.NUXT_PUBLIC_WEB_APP_URL || 'https://web.evb-viewer.com',
        },
    },

    routeRules: {
        '/': { isr: 600 },
        '/features': { prerender: true },
        '/docs': { prerender: true },
        '/privacy': { prerender: true },
        ...Object.fromEntries(
            LOCALE_CODES
                .filter(code => code !== DEFAULT_LOCALE)
                .flatMap(code => [
                    [
                        `/${code}`,
                        { isr: 600 },
                    ],
                    [
                        `/${code}/features`,
                        { prerender: true },
                    ],
                    [
                        `/${code}/docs`,
                        { prerender: true },
                    ],
                    [
                        `/${code}/privacy`,
                        { prerender: true },
                    ],
                ]),
        ),
        '/robots.txt': { prerender: true },
    },

    sitemap: {
        autoI18n: true,
        xslColumns: [
            {
                label: 'URL',
                width: '65%',
            },
            {
                label: 'Last Modified',
                select: 'sitemap:lastmod',
                width: '35%',
            },
        ],
    },

    i18n: {
        restructureDir: 'app',
        locales: LOCALE_DEFINITIONS.map(locale => ({ ...locale })),
        defaultLocale: DEFAULT_LOCALE,
        baseUrl: process.env.NUXT_PUBLIC_SITE_URL || process.env.NUXT_SITE_URL || 'https://evb-viewer.com',
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
        'circle-flags:br',
        'circle-flags:nl',
        'simple-icons:github',
    ]}},

    compatibilityDate: '2025-01-15',
});
