import {
    useLocalStorage,
    useTimeoutFn,
} from '@vueuse/core';
import type { Ref } from 'vue';
import {
    BROWSER_INSTALL_HINT_COOKIE_KEY,
    BROWSER_INSTALL_HINT_STORAGE_KEY,
} from '@app/utils/browserRuntimePersistence';
import type { TAnalyticsEventName } from '@contracts/analytics';

const BROWSER_INSTALL_HINT_AUTO_DISMISS_MS = 60_000;

interface IBrowserInstallHintAnalytics { track: (
    event: TAnalyticsEventName,
    properties?: Record<string, unknown>,
    options?: { includeReferrer?: boolean },
) => void; }

interface IUseBrowserInstallHintOptions {
    analytics: IBrowserInstallHintAnalytics;
    isBrowserRuntime: Ref<boolean>;
}

export const useBrowserInstallHint = (options: IUseBrowserInstallHintOptions) => {
    const runtimeConfig = useRuntimeConfig();
    const browserInstallHintCookie = useCookie<string | null>(
        BROWSER_INSTALL_HINT_COOKIE_KEY,
        {
            default: () => null,
            maxAge: 365 * 24 * 60 * 60,
        },
    );
    const browserInstallHintStorageDismissed = useLocalStorage(
        BROWSER_INSTALL_HINT_STORAGE_KEY,
        false,
    );
    const browserInstallHintDismissed = computed(() => (
        browserInstallHintCookie.value !== null
        || browserInstallHintStorageDismissed.value
    ));
    const isBrowserInstallHintClientReady = ref(false);
    const didTrackViewerSession = useState(
        'analytics:viewer-session-started',
        () => false,
    );
    const didTrackInstallHintShown = useState(
        'analytics:install-hint-shown',
        () => false,
    );
    const browserInstallUrl = computed(() => {
        if (!options.isBrowserRuntime.value) {
            return undefined;
        }

        const url = typeof runtimeConfig.public.landingUrl === 'string'
            ? runtimeConfig.public.landingUrl.trim()
            : '';
        return url || undefined;
    });
    const showBrowserInstallHint = computed(() => (
        options.isBrowserRuntime.value
        && isBrowserInstallHintClientReady.value
        && Boolean(browserInstallUrl.value)
        && !browserInstallHintDismissed.value
    ));

    function getBrowserInstallHost() {
        if (!browserInstallUrl.value) {
            return null;
        }

        try {
            return new URL(browserInstallUrl.value).host;
        } catch {
            return null;
        }
    }

    function trackBrowserInstallHint(action: 'shown' | 'clicked' | 'dismissed' | 'auto_dismissed') {
        options.analytics.track('browser_install_hint_interacted', {
            action,
            destinationHost: getBrowserInstallHost(),
        });
    }

    function handleBrowserInstallHintClick() {
        trackBrowserInstallHint('clicked');
    }

    function dismissBrowserInstallHint(reason: 'manual' | 'auto' = 'manual') {
        if (browserInstallHintDismissed.value) {
            return;
        }

        trackBrowserInstallHint(reason === 'auto' ? 'auto_dismissed' : 'dismissed');

        if (!import.meta.client || !options.isBrowserRuntime.value) {
            return;
        }

        browserInstallHintCookie.value = '1';
        browserInstallHintStorageDismissed.value = true;
    }

    const { start: startBrowserInstallHintAutoDismiss } = useTimeoutFn(
        () => dismissBrowserInstallHint('auto'),
        BROWSER_INSTALL_HINT_AUTO_DISMISS_MS,
        { immediate: false },
    );

    onMounted(() => {
        isBrowserInstallHintClientReady.value = true;

        if (options.isBrowserRuntime.value && !didTrackViewerSession.value) {
            didTrackViewerSession.value = true;
            options.analytics.track('viewer_session_started', {
                installHintVisible: showBrowserInstallHint.value,
                installHintDestinationHost: getBrowserInstallHost(),
            }, { includeReferrer: true });
        }

        if (!options.isBrowserRuntime.value || browserInstallHintDismissed.value) {
            return;
        }

        startBrowserInstallHintAutoDismiss();
    });

    watch(showBrowserInstallHint, (isVisible) => {
        if (!options.isBrowserRuntime.value || !isVisible || didTrackInstallHintShown.value) {
            return;
        }

        didTrackInstallHintShown.value = true;
        trackBrowserInstallHint('shown');
    }, { immediate: true });

    return {
        browserInstallUrl,
        dismissBrowserInstallHint,
        handleBrowserInstallHintClick,
        showBrowserInstallHint,
    };
};
