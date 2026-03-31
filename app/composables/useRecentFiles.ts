import type { IRecentFile } from '@contracts/shared';
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';
import { getElectronAPI } from '@app/utils/platform';
import {
    parseRecentFilesPayload,
    RECENT_FILES_COOKIE_KEY,
} from '@app/utils/recent-files-persistence';

// Deduplication: track in-flight load promise
let loadPromise: Promise<void> | null = null;

export const useRecentFiles = () => {
    const { t } = useTypedI18n();
    const { isDesktopRuntime } = useRuntimeEnvironment();
    const recentFilesCookie = useCookie<string | null>(RECENT_FILES_COOKIE_KEY, {
        default: () => null,
        watch: false,
        decode: val => decodeURIComponent(val),
    });
    const hasRecentFilesCookie = recentFilesCookie.value !== null;
    const recentFiles = useState<IRecentFile[]>(
        'recent-files:list',
        () => parseRecentFilesPayload(recentFilesCookie.value),
    );
    const isLoading = useState('recent-files:is-loading', () => false);
    const error = useState<string | null>('recent-files:error', () => null);
    const isResolved = useState(
        'recent-files:is-resolved',
        () => (!isDesktopRuntime.value || hasRecentFilesCookie),
    );

    async function syncCookieFromRuntime() {
        if (!isDesktopRuntime.value || hasRecentFilesCookie) {
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
            try {
                recentFiles.value = await getElectronAPI().documents.recentFiles.get();
            } catch (e) {
                error.value = e instanceof Error ? e.message : t('errors.recent.load');
            } finally {
                isResolved.value = true;
                isLoading.value = false;
                loadPromise = null;
            }
        })();

        return loadPromise;
    }

    async function openRecentFile(file: IRecentFile) {
        error.value = null;
        try {
            await getElectronAPI().documents.openPdfDirect(file.originalPath);
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.open');
        }
    }

    async function removeRecentFile(file: IRecentFile) {
        error.value = null;
        try {
            await getElectronAPI().documents.recentFiles.remove(file.originalPath);
            await loadRecentFiles();
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.recent.remove');
        }
    }

    async function clearRecentFiles() {
        error.value = null;
        try {
            await getElectronAPI().documents.recentFiles.clear();
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
