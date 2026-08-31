import { getSettingsCapability } from '@app/utils/getSettingsCapability';
import {
    createDebugLogRuntimeErrorReport,
    isUiReportableDebugLog,
} from '@app/utils/runtimeErrorFilter';
import type {TLocale} from '@i18n-app';
import {isLocaleMessageSource} from '@i18n-core';
import {
    isElectronUserAgent,
    waitForPreferredDesktopPlatformBridge,
} from '@app/utils/platform';
import {createPluginTranslate} from '@app/utils/createPluginTranslate';

interface IRuntimeErrorLogStreamState { cleanup: () => void; }

type TRuntimeErrorLogStreamWindow = Window & { __evbRuntimeErrorLogStreamState?: IRuntimeErrorLogStreamState };

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
    // Read messages from the already-loaded vue-i18n composer so this plugin does not
    // pull every locale pack into the entry chunk.
    const t = createPluginTranslate(
        (locale) => {
            const composer: unknown = nuxtApp.$i18n;
            return isLocaleMessageSource(composer)
                ? composer.getLocaleMessage(locale)
                : {};
        },
        () => localeCookie.value,
    );
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
        window.removeEventListener('pagehide', onPageHide);
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
    function onPageHide(event: PageTransitionEvent) {
        if (!event.persisted) {
            cleanup();
        }
    }

    windowWithState.__evbRuntimeErrorLogStreamState = {cleanup};
    window.addEventListener('pagehide', onPageHide);
    nuxtApp.vueApp.unmount = guardedUnmount;

    nuxtApp.hook('app:mounted', () => {
        if (cleanedUp || unsubscribeDebugLog) {
            return;
        }

        void (async () => {
            try {
                if (!await waitForRuntimeErrorLogBridge() || cleanedUp || unsubscribeDebugLog) {
                    return;
                }

                unsubscribeDebugLog = getSettingsCapability().onDebugLog((entry) => {
                    if (!isUiReportableDebugLog(entry)) {
                        return;
                    }

                    reportRuntimeError(createDebugLogRuntimeErrorReport(
                        entry,
                        t('errors.runtime.streamError'),
                    ));
                });
            } catch (error) {
                // The bridge readiness probe only checks for a raw electronAPI
                // object; getSettingsCapability() validates the full contract and
                // can still throw on a partially initialized bridge. Surface that
                // instead of leaking an unhandled rejection.
                reportRuntimeError({
                    title: t('errors.runtime.streamError'),
                    source: 'runtime-error-log-stream',
                    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
                    dedupeKey: 'runtime-error-log-stream-init',
                });
            }
        })();
    });

    if (import.meta.hot) {
        import.meta.hot.dispose(cleanup);
    }
});
