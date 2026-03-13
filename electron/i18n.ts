import {
    DEFAULT_LOCALE,
    LOCALE_MESSAGES,
    type TLocale,
    type TTranslateArgs,
    type TTranslationKey,
} from '@i18n-app';
import {
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    normalizeTranslationParams,
} from '@i18n-core';
import { getCurrentLocaleSync } from '@electron/settings';

type TTeArgs<TKey extends TTranslationKey> = TTranslateArgs<TKey>;

function resolveLocale(locale: string): TLocale {
    return locale in LOCALE_MESSAGES
        ? locale as TLocale
        : DEFAULT_LOCALE;
}

export function te<TKey extends TTranslationKey>(path: TKey, ...args: TTeArgs<TKey>): string {
    const params = normalizeTranslationParams(args[0]);
    const locale = getCurrentLocaleSync();
    const resolvedLocale = resolveLocale(locale);
    const primary = getNestedTranslationLeaf(LOCALE_MESSAGES[resolvedLocale], path);
    const fallback = getNestedTranslationLeaf(LOCALE_MESSAGES[DEFAULT_LOCALE], path);
    const leaf = primary ?? fallback ?? path;
    return formatTranslationLeaf(leaf, params, resolvedLocale);
}
