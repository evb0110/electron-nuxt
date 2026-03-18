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
        ogTitle: () => t('seo.title'),
        ogDescription: () => t('seo.description'),
        ogType: 'website',
        ogSiteName: () => t('app.webTitle'),
        ogUrl: () => canonicalUrl.value,
        ogImage: () => previewImageUrl.value,
        ogImageAlt: () => t('seo.previewAlt'),
        ogLocale: () => locale.value,
        twitterCard: 'summary_large_image',
        twitterTitle: () => t('seo.title'),
        twitterDescription: () => t('seo.description'),
        twitterImage: () => previewImageUrl.value,
    });

    useHead(() => ({
        htmlAttrs: { lang: locale.value },
        link: [{
            rel: 'canonical',
            href: canonicalUrl.value,
        }],
        script: options.noindex
            ? []
            : [{
                key: 'web-app-json-ld',
                type: 'application/ld+json',
                innerHTML: JSON.stringify({
                    '@context': 'https://schema.org',
                    '@type': 'SoftwareApplication',
                    name: t('seo.title'),
                    applicationCategory: 'BusinessApplication',
                    operatingSystem: 'Web',
                    description: t('seo.description'),
                    url: canonicalUrl.value,
                    image: previewImageUrl.value,
                    offers: {
                        '@type': 'Offer',
                        price: '0',
                        priceCurrency: 'USD',
                    },
                    featureList: [
                        t('seo.featurePdf'),
                        t('seo.featureAnnotate'),
                    ],
                }),
            }],
    }));
}
