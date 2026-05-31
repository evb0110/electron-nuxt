import type { IDebugLogEntry } from '@contracts/platformApi';
import { getSettingsCapability } from '@app/utils/platformSettings';
import {
    DEFAULT_LOCALE,
    LOCALE_MESSAGES,
    type TLocale,
    type TTranslateFn,
} from '@i18n-app';
import {
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    normalizeTranslationParams,
} from '@i18n-core';

function isUiReportableLog(entry: IDebugLogEntry) {
    return entry.message.startsWith('[ERROR]');
}

function createPluginTranslate(getLocale: () => TLocale | null | undefined): TTranslateFn {
    const t: TTranslateFn = (key, ...args) => {
        const params = normalizeTranslationParams(args[0]);
        const locale = getLocale() ?? DEFAULT_LOCALE;
        const messages = LOCALE_MESSAGES[locale] ?? LOCALE_MESSAGES[DEFAULT_LOCALE];
        const fallbackMessages = LOCALE_MESSAGES[DEFAULT_LOCALE];
        const leaf = getNestedTranslationLeaf(messages, key)
            ?? getNestedTranslationLeaf(fallbackMessages, key)
            ?? key;

        return formatTranslationLeaf(leaf, params, locale);
    };

    return t;
}

export default defineNuxtPlugin((nuxtApp) => {
    if (!import.meta.client) {
        return;
    }

    const { reportRuntimeError } = useRuntimeErrorReports();
    const localeCookie = useCookie<TLocale>('i18n_redirected');
    const t = createPluginTranslate(() => localeCookie.value);

    nuxtApp.hook('app:mounted', () => {
        getSettingsCapability().onDebugLog((entry) => {
            if (!isUiReportableLog(entry)) {
                return;
            }

            reportRuntimeError({
                title: t('errors.runtime.streamError'),
                source: entry.source,
                error: `${entry.timestamp}\n${entry.message}`,
                dedupeKey: `${entry.source}\n${entry.message}`,
            });
        });
    });
});
