import type {
    TLocale,
    TTranslateFn,
} from '~/i18n/locales';
import {
    DEFAULT_LOCALE,
    createTypedI18nComposer,
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    normalizeTranslationParams,
} from '@i18n-core';

export function useTypedI18n() {
    const composer = useI18n();
    const typedComposer = createTypedI18nComposer<typeof composer, typeof composer.t, TLocale>(composer);
    const t: TTranslateFn = (key, ...args) => {
        const params = normalizeTranslationParams(args[0]);
        const locale = typeof composer.locale?.value === 'string'
            ? composer.locale.value
            : DEFAULT_LOCALE;
        if (typeof composer.getLocaleMessage !== 'function') {
            return params === undefined
                ? composer.t(key)
                : composer.t(key, params);
        }
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

export type TLandingTypedI18nComposer = ReturnType<typeof useTypedI18n>;
