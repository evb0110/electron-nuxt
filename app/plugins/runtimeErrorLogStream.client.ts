import type { IDebugLogEntry } from '@contracts/electronApiCommon';
import { getSettingsCapability } from '@app/utils/getSettingsCapability';
import {
    DEFAULT_LOCALE,
    LOCALE_MESSAGES,
} from '@i18n-app';
import type {
    TLocale,
    TTranslateFn,
} from '@i18n-app';
import {
    formatTranslationLeaf,
    getNestedTranslationLeaf,
    normalizeTranslationParams,
} from '@i18n-core';
import {
    isElectronUserAgent,
    waitForPreferredDesktopPlatformBridge,
} from '@app/utils/platform';

interface IRuntimeErrorLogStreamState { cleanup: () => void; }

type TRuntimeErrorLogStreamWindow = Window & { __evbRuntimeErrorLogStreamState?: IRuntimeErrorLogStreamState };

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

async function waitForRuntimeErrorLogBridge() {
    const routePath = typeof window === 'undefined'
        ? null
        : window.location?.pathname ?? null;
    const bridgeResolution = await waitForPreferredDesktopPlatformBridge({ routePath });
    return !bridgeResolution.shouldWait
        || bridgeResolution.bridgeReady
        || !isElectronUserAgent();
}

export default defineNuxtPlugin((nuxtApp) => {
    if (typeof window === 'undefined') {
        return;
    }

    const windowWithState = window as TRuntimeErrorLogStreamWindow;
    if (windowWithState.__evbRuntimeErrorLogStreamState) {
        return;
    }

    const { reportRuntimeError } = useRuntimeErrorReports();
    const localeCookie = useCookie<TLocale>('i18n_redirected');
    const t = createPluginTranslate(() => localeCookie.value);
    let unsubscribeDebugLog: (() => void) | null = null;
    let cleanedUp = false;

    const cleanupDebugLogSubscription = () => {
        unsubscribeDebugLog?.();
        unsubscribeDebugLog = null;
    };

    const originalUnmount = nuxtApp.vueApp.unmount.bind(nuxtApp.vueApp);
    function cleanup() {
        if (cleanedUp) {
            return;
        }

        cleanedUp = true;
        cleanupDebugLogSubscription();
        window.removeEventListener('beforeunload', onBeforeUnload);
        if (nuxtApp.vueApp.unmount === guardedUnmount) {
            nuxtApp.vueApp.unmount = originalUnmount;
        }
        if (windowWithState.__evbRuntimeErrorLogStreamState?.cleanup === cleanup) {
            delete windowWithState.__evbRuntimeErrorLogStreamState;
        }
    }
    function guardedUnmount() {
        cleanup();
        originalUnmount();
    }
    function onBeforeUnload() {
        cleanup();
    }

    windowWithState.__evbRuntimeErrorLogStreamState = {cleanup};
    window.addEventListener('beforeunload', onBeforeUnload, { once: true });
    nuxtApp.vueApp.unmount = guardedUnmount;

    nuxtApp.hook('app:mounted', () => {
        if (cleanedUp || unsubscribeDebugLog) {
            return;
        }

        void (async () => {
            if (!await waitForRuntimeErrorLogBridge() || cleanedUp || unsubscribeDebugLog) {
                return;
            }

            unsubscribeDebugLog = getSettingsCapability().onDebugLog((entry) => {
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
        })();
    });

    if (import.meta.hot) {
        import.meta.hot.dispose(cleanup);
    }
});
