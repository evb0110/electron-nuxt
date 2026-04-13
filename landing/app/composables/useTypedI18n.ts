import type {
    TLocale,
    TTranslateFn,
} from '~/i18n/locales';
import type { TI18nComposer } from '~/types/i18n';
import { useI18n } from 'vue-i18n';
import {
    DEFAULT_LOCALE,
    createTypedI18nComposer,
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    normalizeTranslationParams,
} from '~/i18n/core';

export function useTypedI18n() {
    const composer = useI18n() as TI18nComposer;
    const typedComposer = createTypedI18nComposer<typeof composer, typeof composer.t, TLocale>(composer);
    const baseTranslate = composer.t.bind(composer);
    const t: TTranslateFn = (key, ...args) => {
        const params = normalizeTranslationParams(args[0]);
        const translated = params === undefined
            ? baseTranslate(key)
            : baseTranslate(key, params);

        if (translated !== key || typeof composer.getLocaleMessage !== 'function') {
            return translated;
        }

        const locale = typeof composer.locale?.value === 'string'
            ? composer.locale.value
            : DEFAULT_LOCALE;
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
