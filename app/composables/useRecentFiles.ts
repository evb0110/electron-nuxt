import type { IRecentFile } from '@app/types/shared';
import { until } from '@vueuse/core';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/electron';

// Vite HMR types (not exposed by Nuxt's type system)
declare global {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting built-in ImportMeta
    interface ImportMeta {hot?: {
        data?: Record<string, unknown>;
        dispose: (callback: (data: Record<string, unknown>) => void) => void;
    };}
}

// Shared state across all composable instances
const recentFiles = ref<IRecentFile[]>([]);
const isLoading = ref(false);
const error = ref<string | null>(null);
const ELECTRON_API_WAIT_TIMEOUT_MS = 2400;

// Deduplication: track in-flight load promise
let loadPromise: Promise<void> | null = null;

async function waitForElectronApiReady(timeoutMs = ELECTRON_API_WAIT_TIMEOUT_MS) {
    if (hasElectronAPI()) {
        return true;
    }
    if (typeof window === 'undefined') {
        return false;
    }

    try {
        await until(() => hasElectronAPI()).toBe(true, { timeout: timeoutMs });
        return true;
    } catch {
        return hasElectronAPI();
    }
}

export const useRecentFiles = () => {
    const { t } = useTypedI18n();

    async function loadRecentFiles() {
        const electronApiReady = await waitForElectronApiReady();
        if (!electronApiReady) {
            return;
        }

        // Deduplicate: if already loading, return existing promise
        if (loadPromise) {
            return loadPromise;
        }

        loadPromise = (async () => {
            isLoading.value = true;
            error.value = null;
            try {
                recentFiles.value = await getElectronAPI().recentFiles.get();
            } catch (e) {
                error.value = e instanceof Error ? e.message : t('errors.recent.load');
            } finally {
                isLoading.value = false;
                loadPromise = null;
            }
        })();

        return loadPromise;
    }

    async function openRecentFile(file: IRecentFile) {
        if (!hasElectronAPI()) {
            return;
        }

        error.value = null;
        try {
            await getElectronAPI().openPdfDirect(file.originalPath);
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.open');
        }
    }

    async function removeRecentFile(file: IRecentFile) {
        if (!hasElectronAPI()) {
            return;
        }

        error.value = null;
        try {
            await getElectronAPI().recentFiles.remove(file.originalPath);
            await loadRecentFiles();
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.recent.remove');
        }
    }

    async function clearRecentFiles() {
        if (!hasElectronAPI()) {
            return;
        }

        error.value = null;
        try {
            await getElectronAPI().recentFiles.clear();
            recentFiles.value = [];
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.recent.clear');
        }
    }

    return {
        recentFiles,
        isLoading,
        error,
        loadRecentFiles,
        openRecentFile,
        removeRecentFile,
        clearRecentFiles,
    };
};

// HMR support: preserve and restore state across hot updates
if (import.meta.hot) {
    // Save current state before the module is replaced
    import.meta.hot.dispose((data) => {
        data.recentFiles = recentFiles.value;
        data.isLoading = isLoading.value;
        data.error = error.value;
    });

    // Restore state from previous module version
    const hmrData = import.meta.hot.data;
    if (hmrData?.recentFiles) {
        recentFiles.value = hmrData.recentFiles as IRecentFile[];
        isLoading.value = (hmrData.isLoading as boolean) ?? false;
        error.value = (hmrData.error as string | null) ?? null;
    }
}
