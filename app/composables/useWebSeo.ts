import { formatWebTitleTemplate } from '@app/utils/app-window-title';

interface IUseWebSeoOptions { noindex?: boolean; }

function normalizeSiteUrl(siteUrl: string) {
    return siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
}

export function useWebSeo(options: IUseWebSeoOptions = {}) {
    const runtimeConfig = useRuntimeConfig();
    const {
        locale,
        t,
    } = useTypedI18n();

    const siteUrl = computed(() => {
        const configuredSiteUrl = typeof runtimeConfig.public.siteUrl === 'string'
            ? runtimeConfig.public.siteUrl.trim()
            : '';
        return normalizeSiteUrl(
            configuredSiteUrl || 'https://evb-viewer-web.vercel.app',
        );
    });
    const canonicalUrl = computed(() => new URL('/', siteUrl.value).toString());
    const previewImageUrl = computed(() => new URL('/evb-viewer-preview-cropped.png', siteUrl.value).toString());
    const robots = computed(() => options.noindex
        ? 'noindex, nofollow'
        : 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1');

    useServerSeoMeta({
        title: () => t('seo.title'),
        description: () => t('seo.description'),
        applicationName: () => t('app.webTitle'),
        robots: () => robots.value,
        author: 'EVB Viewer',
        ogTitle: () => t('seo.title'),
        ogDescription: () => t('seo.description'),
        ogType: 'website',
        ogSiteName: () => t('app.webTitle'),
        ogUrl: () => canonicalUrl.value,
        ogImage: () => previewImageUrl.value,
        ogImageWidth: 2936,
        ogImageHeight: 1935,
        ogImageType: 'image/png',
        ogImageAlt: () => t('seo.previewAlt'),
        ogLocale: () => locale.value,
        twitterCard: 'summary_large_image',
        twitterTitle: () => t('seo.title'),
        twitterDescription: () => t('seo.description'),
        twitterImage: () => previewImageUrl.value,
        twitterImageAlt: () => t('seo.previewAlt'),
    });

    useHead(() => ({
        htmlAttrs: { lang: locale.value },
        titleTemplate: (title) => formatWebTitleTemplate(title, t('app.webTitle')),
        link: [{
            rel: 'canonical',
            href: canonicalUrl.value,
        }],
        script: options.noindex
            ? []
            : [
                {
                    key: 'ld-web-application',
                    type: 'application/ld+json',
                    innerHTML: JSON.stringify({
                        '@context': 'https://schema.org',
                        '@type': 'WebApplication',
                        '@id': `${canonicalUrl.value}#app`,
                        'name': t('seo.title'),
                        'applicationCategory': 'BusinessApplication',
                        'applicationSubCategory': 'Document Viewer',
                        'browserRequirements': 'Requires a modern web browser',
                        'operatingSystem': 'Web',
                        'description': t('seo.description'),
                        'url': canonicalUrl.value,
                        'image': previewImageUrl.value,
                        'screenshot': {
                            '@type': 'ImageObject',
                            'url': previewImageUrl.value,
                            'width': 2936,
                            'height': 1935,
                            'caption': t('seo.screenshotAlt'),
                        },
                        'offers': {
                            '@type': 'Offer',
                            'price': '0',
                            'priceCurrency': 'USD',
                        },
                        'featureList': [
                            t('seo.featurePdf'),
                            t('seo.featureAnnotate'),
                            t('seo.featureSearch'),
                            t('seo.featurePageOps'),
                            t('seo.featureExport'),
                            t('seo.featureMultiTab'),
                        ],
                        'inLanguage': [
                            'en',
                            'ru',
                            'fr',
                            'de',
                            'es',
                            'it',
                            'pt',
                            'nl',
                        ],
                    }),
                },
                {
                    key: 'ld-website',
                    type: 'application/ld+json',
                    innerHTML: JSON.stringify({
                        '@context': 'https://schema.org',
                        '@type': 'WebSite',
                        '@id': `${canonicalUrl.value}#website`,
                        'name': t('app.webTitle'),
                        'url': canonicalUrl.value,
                    }),
                },
                {
                    key: 'ld-webpage',
                    type: 'application/ld+json',
                    innerHTML: JSON.stringify({
                        '@context': 'https://schema.org',
                        '@type': 'WebPage',
                        '@id': `${canonicalUrl.value}#webpage`,
                        'name': t('seo.title'),
                        'description': t('seo.description'),
                        'url': canonicalUrl.value,
                        'isPartOf': { '@id': `${canonicalUrl.value}#website` },
                        'mainEntity': { '@id': `${canonicalUrl.value}#app` },
                        'primaryImageOfPage': {
                            '@type': 'ImageObject',
                            'url': previewImageUrl.value,
                        },
                        'inLanguage': locale.value,
                    }),
                },
            ],
    }));
}
