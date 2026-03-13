import type {
    TLocale,
    TTranslateFn,
} from '@i18n-app';
import {
    DEFAULT_LOCALE,
    createTypedI18nComposer,
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    normalizeTranslationParams,
} from '@i18n-core';

interface IAppTypedI18nComposer {
    t: TTranslateFn;
    setLocale: (locale: TLocale) => Promise<void>;
    loadLocaleMessages: (locale: TLocale) => Promise<void>;
}

export function useTypedI18n(): IAppTypedI18nComposer {
    const composer = useI18n();
    const typedComposer = createTypedI18nComposer<typeof composer, typeof composer.t, TLocale>(composer);
    const t: TTranslateFn = (key, ...args) => {
        const params = normalizeTranslationParams(args[0]);
        const locale = composer.locale.value;
        const primaryMessages = composer.getLocaleMessage(locale);
        const fallbackMessages = composer.getLocaleMessage(DEFAULT_LOCALE);
        const primary = getNestedTranslationLeaf(primaryMessages, key);
        const fallback = getNestedTranslationLeaf(fallbackMessages, key);
        const leaf = primary ?? fallback ?? key;
        return formatTranslationLeaf(leaf, params, locale);
    };

    return {
        ...typedComposer,
        t,
    };
}
