import type { IRecentFile } from '@contracts/shared';
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';
import {
    getElectronAPI,
    hasElectronAPI,
    isElectronRoutePath,
} from '@app/utils/platform';
import {
    parseRecentFilesCookieSnapshot,
    RECENT_FILES_COOKIE_KEY,
} from '@app/utils/recent-files-persistence';

// Deduplication: track in-flight load promise
let loadPromise: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
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
        decode: val => decodeURIComponent(val),
    });
    const initialCookieSnapshot = parseRecentFilesCookieSnapshot(recentFilesCookie.value);
    const hasResolvedCookieSnapshot = initialCookieSnapshot.hasSnapshot && !initialCookieSnapshot.truncated;
    const recentFiles = useState<IRecentFile[]>(
        'recent-files:list',
        () => initialCookieSnapshot.recentFiles,
    );
    const isLoading = useState('recent-files:is-loading', () => false);
    const error = useState<string | null>('recent-files:error', () => null);
    const isResolved = useState(
        'recent-files:is-resolved',
        () => !isDesktopRuntime.value && hasResolvedCookieSnapshot,
    );
    const shouldPreferElectronRuntime = computed(() => (
        hasElectronAPI()
        || isDesktopRuntime.value
        || isElectronRoutePath(route.path)
    ));

    function clearRetryTimer() {
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
    }

    function scheduleRetry() {
        if (retryTimer) {
            return;
        }

        retryTimer = setTimeout(() => {
            retryTimer = null;
            void loadRecentFiles();
        }, ELECTRON_RECENT_FILES_RETRY_DELAY_MS);
    }

    async function waitForElectronBridge() {
        if (!shouldPreferElectronRuntime.value || hasElectronAPI()) {
            return;
        }

        for (let attempt = 0; attempt < ELECTRON_BRIDGE_RETRY_ATTEMPTS; attempt += 1) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, ELECTRON_BRIDGE_RETRY_DELAY_MS);
            });

            if (hasElectronAPI()) {
                return;
            }
        }
    }

    async function getDocumentsCapability() {
        if (!shouldPreferElectronRuntime.value) {
            return getElectronAPI().documents;
        }

        await waitForElectronBridge();

        if (!hasElectronAPI()) {
            throw new Error('Electron API unavailable');
        }

        return getElectronAPI().documents;
    }

    async function syncCookieFromRuntime() {
        if (shouldPreferElectronRuntime.value || hasResolvedCookieSnapshot) {
            return;
        }

        try {
            await getElectronAPI().documents.recentFiles.get();
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.recent.load');
        }
    }

    async function loadRecentFiles() {
        // Deduplicate: if already loading, return existing promise
        if (loadPromise) {
            return loadPromise;
        }

        loadPromise = (async () => {
            isLoading.value = true;
            error.value = null;
            let loadedSuccessfully = false;
            let shouldRetryAfterFailure = false;
            try {
                recentFiles.value = await (await getDocumentsCapability()).recentFiles.get();
                loadedSuccessfully = true;
                isResolved.value = true;
                clearRetryTimer();
            } catch (e) {
                error.value = e instanceof Error ? e.message : t('errors.recent.load');
                if (shouldPreferElectronRuntime.value) {
                    shouldRetryAfterFailure = true;
                } else {
                    isResolved.value = true;
                }
            } finally {
                if (loadedSuccessfully) {
                    isResolved.value = true;
                }
                isLoading.value = false;
                loadPromise = null;
                if (shouldRetryAfterFailure) {
                    scheduleRetry();
                }
            }
        })();

        return loadPromise;
    }

    async function openRecentFile(file: IRecentFile) {
        error.value = null;
        try {
            await (await getDocumentsCapability()).openPdfDirect(file.originalPath);
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
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.recent.clear');
        }
    }

    return {
        recentFiles,
        isLoading,
        isResolved,
        error,
        loadRecentFiles,
        syncCookieFromRuntime,
        openRecentFile,
        removeRecentFile,
        clearRecentFiles,
    };
};
