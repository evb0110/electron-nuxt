import type { IRecentFile } from '@contracts/shared';
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';
import {
    shouldPreferDesktopPlatform,
    waitForDesktopPlatformBridge,
} from '@app/utils/platform';
import {readBrowserRecentFilesSnapshot} from '@app/utils/recentFilesPersistence';
import { usePlatformHydratedState } from '@app/composables/usePlatformHydratedState';
import {
    getDocumentOpenCapability as getPlatformDocumentOpenCapability,
    getDocumentRecentFilesCapability as getPlatformDocumentRecentFilesCapability,
} from '@app/utils/platformDocuments';

const ELECTRON_BRIDGE_RETRY_DELAY_MS = 25;
const ELECTRON_BRIDGE_RETRY_ATTEMPTS = 20;
const ELECTRON_RECENT_FILES_RETRY_DELAY_MS = 750;

export const useRecentFiles = () => {
    const { t } = useTypedI18n();
    const toast = useToast();
    const { isDesktopRuntime } = useRuntimeEnvironment();
    const route = useRoute();
    const initialCookieSnapshot = readBrowserRecentFilesSnapshot();
    const hasResolvedCookieSnapshot = initialCookieSnapshot.hasSnapshot && !initialCookieSnapshot.truncated;
    const shouldPreferElectronRuntime = computed(() => (
        shouldPreferDesktopPlatform(route.path, isDesktopRuntime.value)
    ));
    const hasUsableInitialSnapshot = computed(() => (
        !shouldPreferElectronRuntime.value && hasResolvedCookieSnapshot
    ));

    async function waitForDocumentsCapabilityBridge() {
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
    }

    async function getDocumentOpenCapability() {
        await waitForDocumentsCapabilityBridge();

        return getPlatformDocumentOpenCapability();
    }

    async function getDocumentRecentFilesCapability() {
        await waitForDocumentsCapabilityBridge();

        return getPlatformDocumentRecentFilesCapability();
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
            return (await getDocumentRecentFilesCapability()).recentFiles.get();
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

    async function openRecentFile(file: IRecentFile) {
        error.value = null;
        try {
            await (await getDocumentOpenCapability()).openDocumentDirect(file.originalPath);
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.open');
        }
    }

    async function removeRecentFile(file: IRecentFile) {
        error.value = null;
        try {
            await (await getDocumentRecentFilesCapability()).recentFiles.remove(file.originalPath);
            await loadRecentFiles();
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.recent.remove');
        }
    }

    async function removeRecentFileIfMissing(file: IRecentFile) {
        error.value = null;
        try {
            const removed = await (await getDocumentRecentFilesCapability())
                .recentFiles.removeIfMissing(file.originalPath);
            if (!removed) {
                return false;
            }
            recentFiles.value = recentFiles.value.filter(
                candidate => candidate.originalPath !== file.originalPath,
            );
            isResolved.value = true;
            clearRetryTimer();
            toast.add({
                color: 'error',
                title: t('errors.recent.notFoundTitle'),
                description: t('errors.recent.notFoundDescription', {name: file.fileName}),
            });
            return true;
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.recent.remove');
            return false;
        }
    }

    async function clearRecentFiles() {
        error.value = null;
        try {
            await (await getDocumentRecentFilesCapability()).recentFiles.clear();
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
        openRecentFile,
        removeRecentFile,
        removeRecentFileIfMissing,
        clearRecentFiles,
    };
};
