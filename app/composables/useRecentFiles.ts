import type { IRecentFile } from '@contracts/shared';
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';
import {
    shouldPreferDesktopPlatform,
    waitForDesktopPlatformBridge,
} from '@app/utils/platform';
import {
    parseRecentFilesCookieSnapshot,
    readBrowserRecentFilesSnapshot,
    RECENT_FILES_COOKIE_KEY,
} from '@app/utils/recentFilesPersistence';
import { usePlatformHydratedState } from '@app/composables/usePlatformHydratedState';
import { getDocumentsCapability as getPlatformDocumentsCapability } from '@app/utils/platformDocuments';

const ELECTRON_BRIDGE_RETRY_DELAY_MS = 25;
const ELECTRON_BRIDGE_RETRY_ATTEMPTS = 20;
const ELECTRON_RECENT_FILES_RETRY_DELAY_MS = 750;

export const useRecentFiles = () => {
    const { t } = useTypedI18n();
    const { isDesktopRuntime } = useRuntimeEnvironment();
    const route = useRoute();
    const recentFilesCookie = useCookie<string | null>(RECENT_FILES_COOKIE_KEY, {
        default: () => null,
        watch: false,
        decode: value => typeof value === 'string'
            ? decodeURIComponent(value)
            : null,
    });
    const initialCookieSnapshot = import.meta.client
        ? readBrowserRecentFilesSnapshot()
        : parseRecentFilesCookieSnapshot(recentFilesCookie.value);
    const hasResolvedCookieSnapshot = initialCookieSnapshot.hasSnapshot && !initialCookieSnapshot.truncated;
    const shouldPreferElectronRuntime = computed(() => (
        shouldPreferDesktopPlatform(route.path, isDesktopRuntime.value)
    ));
    const hasUsableInitialSnapshot = computed(() => (
        !shouldPreferElectronRuntime.value && hasResolvedCookieSnapshot
    ));

    async function getDocumentsCapability() {
        if (shouldPreferElectronRuntime.value) {
            const bridgeReady = await waitForDesktopPlatformBridge({
                shouldWait: shouldPreferElectronRuntime.value,
                attempts: ELECTRON_BRIDGE_RETRY_ATTEMPTS,
                retryDelayMs: ELECTRON_BRIDGE_RETRY_DELAY_MS,
            });

            if (!bridgeReady) {
                throw new Error('Electron API unavailable');
            }
        }

        return getPlatformDocumentsCapability();
    }

    const {
        state: recentFiles,
        isLoading,
        isResolved,
        error,
        load: loadRecentFilesState,
        clearRetryTimer,
    } = usePlatformHydratedState<IRecentFile[]>({
        key: 'recentFiles',
        initialValue: () => initialCookieSnapshot.recentFiles,
        initialResolved: !isDesktopRuntime.value && hasResolvedCookieSnapshot,
        async loadValue() {
            return (await getDocumentsCapability()).recentFiles.get();
        },
        getErrorMessage(loadError) {
            return loadError instanceof Error ? loadError.message : t('errors.recent.load');
        },
        shouldRetry() {
            return shouldPreferElectronRuntime.value;
        },
        retryDelayMs: ELECTRON_RECENT_FILES_RETRY_DELAY_MS,
        markResolvedOnError() {
            return !shouldPreferElectronRuntime.value;
        },
    });

    async function loadRecentFiles() {
        await loadRecentFilesState();
    }

    async function syncCookieFromRuntime() {
        if (shouldPreferElectronRuntime.value || hasResolvedCookieSnapshot) {
            return;
        }

        try {
            await (await getDocumentsCapability()).recentFiles.get();
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.recent.load');
        }
    }

    async function openRecentFile(file: IRecentFile) {
        error.value = null;
        try {
            await (await getDocumentsCapability()).openDocumentDirect(file.originalPath);
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.open');
        }
    }

    async function removeRecentFile(file: IRecentFile) {
        error.value = null;
        try {
            await (await getDocumentsCapability()).recentFiles.remove(file.originalPath);
            await loadRecentFiles();
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.recent.remove');
        }
    }

    async function clearRecentFiles() {
        error.value = null;
        try {
            await (await getDocumentsCapability()).recentFiles.clear();
            recentFiles.value = [];
            isResolved.value = true;
            clearRetryTimer();
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.recent.clear');
        }
    }

    return {
        recentFiles,
        isLoading,
        isResolved,
        hasUsableInitialSnapshot,
        error,
        loadRecentFiles,
        syncCookieFromRuntime,
        openRecentFile,
        removeRecentFile,
        clearRecentFiles,
    };
};
