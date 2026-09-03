import { getSettingsCapability } from '@app/utils/getSettingsCapability';
import type {IDebugLogEntry} from '@contracts/electronApiCommon';
import {
    createDebugLogRuntimeErrorReport,
    createDebugLogRuntimeErrorPresentation,
    isUiReportableDebugLog,
} from '@app/utils/runtimeErrorFilter';
import type {TLocale} from '@i18n-app';
import {isLocaleMessageSource} from '@i18n-core';
import {
    isElectronUserAgent,
    waitForPreferredDesktopPlatformBridge,
} from '@app/utils/platform';
import {createPluginTranslate} from '@app/utils/createPluginTranslate';
import {getValidatedElectronPlatformApi} from '@app/utils/electronPlatformBridge';
import {initializeRendererFailureReporter} from '@app/utils/failureReporter';

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
    const handleDebugLog = (entry: IDebugLogEntry) => {
        if (!isUiReportableDebugLog(entry)) {
            return;
        }

        const title = t('errors.runtime.streamError');
        const presentation = createDebugLogRuntimeErrorPresentation(entry, title);
        if (presentation) {
            reportRuntimeError(presentation);
            return;
        }
        reportRuntimeError(createDebugLogRuntimeErrorReport(entry, title));
    };
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

                if (isElectronUserAgent()) {
                    const diagnostics = getValidatedElectronPlatformApi()?.diagnostics;
                    if (!diagnostics) {
                        throw new Error('Electron diagnostics capability is unavailable');
                    }
                    unsubscribeDebugLog = diagnostics.onDebugLog(handleDebugLog);
                    return;
                }

                unsubscribeDebugLog = getSettingsCapability().onDebugLog(handleDebugLog);
            } catch {
                // The bridge readiness probe can finish before the diagnostics
                // capability is available. This is a separate renderer fault,
                // so it owns one occurrence and then presents that receipt.
                const failure = initializeRendererFailureReporter({host: isElectronUserAgent() ? 'electron' : 'hosted-browser'}).capture({
                    code: 'UNCLASSIFIED_RENDERER_ERROR',
                    context: {},
                    local: {
                        source: 'runtime-error-log-stream',
                        message: 'Electron diagnostics log stream initialization failed',
                    },
                });
                reportRuntimeError({
                    failure,
                    title: t('errors.runtime.streamError'),
                });
            }
        })();
    });

    if (import.meta.hot) {
        import.meta.hot.dispose(cleanup);
    }
});
