import type {
    TLocale,
    TTranslateFn,
} from '@i18n-app';
import {
    DEFAULT_LOCALE,
    LOCALE_CODES,
    createTypedI18nComposer,
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    normalizeTranslationParams,
} from '@i18n-core';

const SUPPORTED_LOCALES = new Set<string>(LOCALE_CODES);

function isSupportedLocale(locale: string): locale is TLocale {
    return SUPPORTED_LOCALES.has(locale);
}

interface IAppTypedI18nComposer {
    locale: Ref<TLocale>;
    t: TTranslateFn;
    setLocale: (locale: TLocale) => Promise<void>;
    loadLocaleMessages: (locale: TLocale) => Promise<void>;
}

export const useTypedI18n = (): IAppTypedI18nComposer => {
    const composer = useI18n();
    const typedComposer = createTypedI18nComposer<typeof composer, typeof composer.t, TLocale>(composer);
    const locale = computed<TLocale>(() => (
        typeof composer.locale?.value === 'string'
            && isSupportedLocale(composer.locale.value)
            ? composer.locale.value
            : DEFAULT_LOCALE
    ));
    const t: TTranslateFn = (key, ...args) => {
        const params = normalizeTranslationParams(args[0]);
        const currentLocale = locale.value;
        if (typeof composer.getLocaleMessage !== 'function') {
            return params === undefined
                ? composer.t(key)
                : composer.t(key, params);
        }
        const primaryMessages = composer.getLocaleMessage(currentLocale);
        const fallbackMessages = composer.getLocaleMessage(DEFAULT_LOCALE);
        const primary = getNestedTranslationLeaf(primaryMessages, key);
        const fallback = getNestedTranslationLeaf(fallbackMessages, key);
        const leaf = primary ?? fallback ?? key;
        return formatTranslationLeaf(leaf, params, currentLocale);
    };

    return {
        ...typedComposer,
        locale,
        t,
    };
};
