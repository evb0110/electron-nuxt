import type { IRecentFile } from '@contracts/shared';
import { until } from '@vueuse/core';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/electron';
import {
    getOptionalNumber,
    getOptionalString,
    isRecord,
} from '@app/services/pdfjs/runtime';

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

function toRecentFile(value: unknown): IRecentFile | null {
    if (!isRecord(value)) {
        return null;
    }

    const originalPath = getOptionalString(value, 'originalPath');
    const fileName = getOptionalString(value, 'fileName');
    const timestamp = getOptionalNumber(value, 'timestamp');
    if (!originalPath || !fileName || timestamp === null) {
        return null;
    }

    const fileSize = getOptionalNumber(value, 'fileSize') ?? undefined;
    return {
        originalPath,
        fileName,
        timestamp,
        fileSize,
    };
}

function readRecentFilesHmrState(data: unknown) {
    if (!isRecord(data)) {
        return null;
    }

    const normalizedRecentFiles = Array.isArray(data.recentFiles)
        ? data.recentFiles
            .map(toRecentFile)
            .filter((value): value is IRecentFile => value !== null)
        : null;

    return {
        recentFiles: normalizedRecentFiles,
        isLoading: getOptionalBooleanValue(data, 'isLoading'),
        error: getOptionalNullableStringValue(data, 'error'),
    };
}

function getOptionalBooleanValue(
    value: Record<PropertyKey, unknown>,
    key: PropertyKey,
) {
    const candidate = value[key];
    return typeof candidate === 'boolean'
        ? candidate
        : null;
}

function getOptionalNullableStringValue(
    value: Record<PropertyKey, unknown>,
    key: PropertyKey,
) {
    const candidate = value[key];
    return typeof candidate === 'string' || candidate === null
        ? candidate
        : null;
}

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
                recentFiles.value = await getElectronAPI().documents.recentFiles.get();
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
            await getElectronAPI().documents.openPdfDirect(file.originalPath);
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
            await getElectronAPI().documents.recentFiles.remove(file.originalPath);
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
            await getElectronAPI().documents.recentFiles.clear();
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
    const previousState = readRecentFilesHmrState(import.meta.hot.data);
    if (previousState?.recentFiles) {
        recentFiles.value = previousState.recentFiles;
        isLoading.value = previousState.isLoading ?? false;
        error.value = previousState.error ?? null;
    }
}
