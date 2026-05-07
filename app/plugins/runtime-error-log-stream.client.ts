import type { IDebugLogEntry } from '@contracts/platform-api';
import { getSettingsCapability } from '@app/utils/platform-settings';
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
    return entry.message.startsWith('[WARN]') || entry.message.startsWith('[ERROR]');
}

function createPluginTranslate(): TTranslateFn {
    const t: TTranslateFn = (key, ...args) => {
        const params = normalizeTranslationParams(args[0]);
        const locale = useCookie<TLocale>('i18n_redirected').value ?? DEFAULT_LOCALE;
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
    const t = createPluginTranslate();

    nuxtApp.hook('app:mounted', () => {
        getSettingsCapability().onDebugLog((entry) => {
            if (!isUiReportableLog(entry)) {
                return;
            }

            reportRuntimeError({
                title: entry.message.startsWith('[ERROR]')
                    ? t('errors.runtime.streamError')
                    : t('errors.runtime.streamWarning'),
                source: entry.source,
                error: `${entry.timestamp}\n${entry.message}`,
            });
        });
    });
});
