<template>
    <div class="workspace-host">
        <component
            :is="DocumentWorkspace"
            v-if="workspaceRequested"
            ref="workspaceRef"
            :tab-id="tabId"
            :is-active="isActive"
            :pending-document-open="isDocumentOpenInFlight"
            @update-tab="(updates) => emit('update-tab', updates)"
            @open-in-new-tab="(result) => emit('open-in-new-tab', result)"
            @request-close-tab="emit('request-close-tab')"
            @open-settings="emit('open-settings')"
        />

        <div v-else class="workspace-host__placeholder">
            <PdfEmptyState
                :recent-files="recentFiles"
                :open-batch-progress="null"
                @open-file="handleOpenFileFromUi"
                @open-recent="handleOpenRecentFromPlaceholder"
                @remove-recent="handleRemoveRecentFromPlaceholder"
                @clear-recent="handleClearRecentFromPlaceholder"
            />
        </div>

        <div
            v-if="isHostLoaderVisible"
            class="workspace-host__loading"
            role="status"
            aria-live="polite"
        >
            <div class="flex flex-col items-center gap-2">
                <UIcon name="i-lucide-loader-circle" class="workspace-host__spinner" />
                <span class="text-sm text-[var(--ui-text-muted)]">{{ t('common.loading') }}</span>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    defineAsyncComponent,
    nextTick,
    onMounted,
    ref,
    watch,
} from 'vue';
import type { TOpenFileResult } from '@app/types/electron-api';
import type { IRecentFile } from '@app/types/shared';
import type { TTabUpdate } from '@app/types/tabs';
import type { TSplitPayload } from '@app/types/split-payload';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import { BrowserLogger } from '@app/utils/browser-logger';
import { useRecentFiles } from '@app/composables/useRecentFiles';
import { useWorkspaceSplitCache } from '@app/composables/useWorkspaceSplitCache';
import { resolveWorkspaceRequestedState } from '@app/composables/page/workspace-host-mounting';

const props = defineProps<{
    tabId: string;
    isActive: boolean;
    hasDocumentHint?: boolean;
}>();
const { t } = useTypedI18n();

const emit = defineEmits<{
    'update-tab': [updates: TTabUpdate];
    'open-in-new-tab': [result: TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
}>();
const RECENT_OPEN_LOG_SECTION = 'recent-open';
const LOADER_LOG_SECTION = 'loader';

const loadDocumentWorkspace = () => import('@app/components/DocumentWorkspace.vue');
function isRecoverableChunkLoadError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return (
        message.includes('Failed to fetch dynamically imported module')
        || message.includes('Importing a module script failed')
        || message.includes('Outdated Optimize Dep')
    );
}

const DocumentWorkspace = defineAsyncComponent({
    loader: loadDocumentWorkspace,
    suspensible: false,
    onError: (error, retry, fail, attempts) => {
        BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'DocumentWorkspace async chunk load failed', {
            tabId: props.tabId,
            attempts,
            error,
        });

        if (import.meta.dev && attempts < 3 && isRecoverableChunkLoadError(error)) {
            setTimeout(() => retry(), attempts * 150);
            return;
        }

        fail();
    },
});

const workspaceRequested = ref(false);
const workspaceRef = ref<unknown>(null);
let workspaceLoadPromise: Promise<IWorkspaceExpose | null> | null = null;
let workspacePreloadPromise: Promise<boolean> | null = null;
const documentOpenInFlightCount = ref(0);
const workspaceSplitCache = useWorkspaceSplitCache();
const WORKSPACE_MOUNT_TIMEOUT_MS = 30_000;
const WORKSPACE_MOUNT_RETRY_TIMEOUT_MS = 20_000;
const REQUIRED_WORKSPACE_METHODS: Array<keyof Omit<IWorkspaceExpose, 'hasPdf'>> = [
    'handleSave',
    'handleSaveAs',
    'handleUndo',
    'handleRedo',
    'handleOpenFileFromUi',
    'handleOpenFileDirectWithPersist',
    'handleOpenFileDirectBatchWithPersist',
    'handleOpenFileWithResult',
    'handleCloseFileFromUi',
    'handleExportDocx',
    'handleExportImages',
    'handleExportMultiPageTiff',
    'handleZoomIn',
    'handleZoomOut',
    'handleFitWidth',
    'handleFitHeight',
    'handleActualSize',
    'handleViewModeSingle',
    'handleViewModeFacing',
    'handleViewModeFacingFirstSingle',
    'handleDeletePages',
    'handleExtractPages',
    'handleRotateCw',
    'handleRotateCcw',
    'handleInsertPages',
    'handleConvertToPdf',
    'captureSplitPayload',
    'restoreSplitPayload',
    'closeAllDropdowns',
];

const {
    recentFiles,
    loadRecentFiles,
    removeRecentFile,
    clearRecentFiles,
} = useRecentFiles();

function isWorkspaceExpose(value: unknown): value is IWorkspaceExpose {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    if (!('hasPdf' in candidate)) {
        return false;
    }

    return REQUIRED_WORKSPACE_METHODS.every(methodName => typeof candidate[methodName] === 'function');
}

const mountedWorkspace = computed<IWorkspaceExpose | null>(() => (
    isWorkspaceExpose(workspaceRef.value) ? workspaceRef.value : null
));
const hasMountedWorkspace = computed(() => mountedWorkspace.value !== null);

const hasPdf = computed<boolean>(() => {
    const value = mountedWorkspace.value?.hasPdf;
    if (typeof value === 'boolean') {
        return value;
    }
    return value?.value ?? false;
});
const hasQueuedSplitRestore = computed(() => workspaceSplitCache.has(props.tabId));
const isDocumentOpenInFlight = computed(() => documentOpenInFlightCount.value > 0);
const isHostLoaderVisible = computed(() => (
    isDocumentOpenInFlight.value
    || (workspaceRequested.value && !hasMountedWorkspace.value)
));
const loaderVariant = computed(() => {
    if (!isHostLoaderVisible.value) {
        return 'none';
    }

    if (isDocumentOpenInFlight.value && workspaceRequested.value && !hasMountedWorkspace.value) {
        return 'placeholder-open:mounting-workspace';
    }

    if (isDocumentOpenInFlight.value && !workspaceRequested.value) {
        return 'placeholder-open:awaiting-mount-request';
    }

    if (workspaceRequested.value && !hasMountedWorkspace.value) {
        return 'workspace-mount';
    }

    return 'document-open';
});

watch(
    [
        hasQueuedSplitRestore,
        () => props.hasDocumentHint === true,
        () => props.isActive,
    ],
    ([
        hasQueued,
        hasDocumentHint,
        isActive,
    ]) => {
        workspaceRequested.value = resolveWorkspaceRequestedState(workspaceRequested.value, {
            hasQueuedSplitRestore: hasQueued,
            hasDocumentHint,
            isActive,
        });
    },
    { immediate: true },
);

watch(loaderVariant, (nextVariant, previousVariant) => {
    if (nextVariant === previousVariant) {
        return;
    }

    BrowserLogger.info(LOADER_LOG_SECTION, 'Workspace host loader variant changed', {
        tabId: props.tabId,
        previousVariant,
        nextVariant,
        spinnerSizeRem: 1.25,
        isDocumentOpenInFlight: isDocumentOpenInFlight.value,
        workspaceRequested: workspaceRequested.value,
        hasMountedWorkspace: hasMountedWorkspace.value,
    });
}, { immediate: true });

function workspaceHasPdf(workspace: IWorkspaceExpose) {
    const value = workspace.hasPdf;
    return typeof value === 'boolean' ? value : value.value;
}

async function runWhileOpeningDocument(run: () => Promise<void>) {
    documentOpenInFlightCount.value += 1;
    try {
        await run();
    } finally {
        documentOpenInFlightCount.value = Math.max(0, documentOpenInFlightCount.value - 1);
    }
}

function sleep(ms: number) {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function preloadWorkspaceComponent(reason: string) {
    if (workspacePreloadPromise) {
        return workspacePreloadPromise;
    }

    BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'Preloading DocumentWorkspace chunk', {
        tabId: props.tabId,
        reason,
    });

    workspacePreloadPromise = loadDocumentWorkspace()
        .then(() => {
            BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'DocumentWorkspace chunk preloaded', {
                tabId: props.tabId,
                reason,
            });
            return true;
        })
        .catch((error) => {
            BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'Failed to preload DocumentWorkspace chunk', {
                tabId: props.tabId,
                reason,
                error,
            });
            return false;
        })
        .finally(() => {
            workspacePreloadPromise = null;
        });

    return workspacePreloadPromise;
}

async function waitForWorkspaceMount(timeoutMs = WORKSPACE_MOUNT_TIMEOUT_MS) {
    const start = Date.now();
    while (Date.now() - start <= timeoutMs) {
        const workspace = mountedWorkspace.value;
        if (workspace) {
            return workspace;
        }
        await nextTick();
        await sleep(16);
    }
    return null;
}

async function ensureWorkspaceLoaded(reason: string) {
    if (mountedWorkspace.value) {
        return mountedWorkspace.value;
    }

    const preloadSucceeded = await preloadWorkspaceComponent(`ensureWorkspaceLoaded:${reason}`);
    if (!preloadSucceeded) {
        BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Proceeding with workspace mount after preload failure', {
            tabId: props.tabId,
            reason,
        });
    }

    BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'Requesting workspace mount', {
        tabId: props.tabId,
        reason,
        workspaceRequested: workspaceRequested.value,
    });

    workspaceRequested.value = true;
    if (!workspaceLoadPromise) {
        workspaceLoadPromise = waitForWorkspaceMount().finally(() => {
            workspaceLoadPromise = null;
        });
    }

    const loadedWorkspace = await workspaceLoadPromise;
    if (!loadedWorkspace) {
        BrowserLogger.error('workspace-host', 'Workspace load timed out', {
            tabId: props.tabId,
            reason,
        });
    } else {
        BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'Workspace mount ready', {
            tabId: props.tabId,
            reason,
        });
    }
    return loadedWorkspace;
}

async function withLoadedWorkspace(action: string, run: (workspace: IWorkspaceExpose) => Promise<void> | void) {
    const workspace = mountedWorkspace.value;
    if (!workspace) {
        return;
    }

    try {
        await run(workspace);
    } catch (error) {
        BrowserLogger.error('workspace-host', `Action failed (${action})`, {
            tabId: props.tabId,
            error,
        });
    }
}

async function withWorkspace(action: string, run: (workspace: IWorkspaceExpose) => Promise<void> | void) {
    BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'withWorkspace start', {
        tabId: props.tabId,
        action,
        hasMountedWorkspace: hasMountedWorkspace.value,
        workspaceRequested: workspaceRequested.value,
    });

    let workspace = mountedWorkspace.value ?? await ensureWorkspaceLoaded(action);
    if (!workspace) {
        workspace = await waitForWorkspaceMount(WORKSPACE_MOUNT_RETRY_TIMEOUT_MS);
    }
    if (!workspace) {
        BrowserLogger.error('workspace-host', 'Workspace unavailable for action', {
            tabId: props.tabId,
            action,
        });
        return;
    }

    try {
        await run(workspace);
        BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'withWorkspace completed', {
            tabId: props.tabId,
            action,
            hasPdf: workspaceHasPdf(workspace),
        });
    } catch (error) {
        BrowserLogger.error('workspace-host', `Action failed (${action})`, {
            tabId: props.tabId,
            error,
        });
    }
}

async function openPath(path: string, action: string) {
    BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'Attempting open path', {
        tabId: props.tabId,
        action,
        path,
    });
    await withWorkspace(action, workspace => workspace.handleOpenFileDirectWithPersist(path));
}

async function handleOpenRecentFromPlaceholder(file: IRecentFile) {
    BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'Recent item clicked from placeholder', {
        tabId: props.tabId,
        path: file.originalPath,
        workspaceRequested: workspaceRequested.value,
        hasMountedWorkspace: hasMountedWorkspace.value,
    });

    const preloadedWorkspace = mountedWorkspace.value ?? await ensureWorkspaceLoaded('openRecentFromPlaceholder:preload');
    if (!preloadedWorkspace) {
        BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'Failed to preload workspace for recent open', {
            tabId: props.tabId,
            path: file.originalPath,
        });
        return;
    }

    await runWhileOpeningDocument(async () => {
        await openPath(file.originalPath, 'openRecentFromPlaceholder');
    });
}

async function handleRemoveRecentFromPlaceholder(file: IRecentFile) {
    await removeRecentFile(file);
}

async function handleClearRecentFromPlaceholder() {
    await clearRecentFiles();
}

async function handleOpenFileFromUi() {
    await withWorkspace('handleOpenFileFromUi', async (workspace) => {
        await workspace.handleOpenFileFromUi();
    });
}

onMounted(() => {
    void preloadWorkspaceComponent('workspace-host-mounted');

    BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'Workspace host mounted; loading recent files', {tabId: props.tabId});
    void loadRecentFiles().finally(() => {
        BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'Workspace host recent files load settled', {
            tabId: props.tabId,
            count: recentFiles.value.length,
        });
    });
});

const workspaceExpose: IWorkspaceExpose = {
    handleSave: async () => {
        await withLoadedWorkspace('handleSave', workspace => workspace.handleSave());
    },
    handleSaveAs: async () => {
        await withLoadedWorkspace('handleSaveAs', workspace => workspace.handleSaveAs());
    },
    handleUndo: () => {
        void withLoadedWorkspace('handleUndo', workspace => workspace.handleUndo());
    },
    handleRedo: () => {
        void withLoadedWorkspace('handleRedo', workspace => workspace.handleRedo());
    },
    handleOpenFileFromUi,
    handleOpenFileDirectWithPersist: async (path: string) => {
        await runWhileOpeningDocument(async () => {
            await openPath(path, 'handleOpenFileDirectWithPersist');
        });
    },
    handleOpenFileDirectBatchWithPersist: async (paths: string[]) => {
        await runWhileOpeningDocument(async () => {
            await withWorkspace(
                'handleOpenFileDirectBatchWithPersist',
                workspace => workspace.handleOpenFileDirectBatchWithPersist(paths),
            );
        });
    },
    handleOpenFileWithResult: async (result: TOpenFileResult) => {
        await runWhileOpeningDocument(async () => {
            await withWorkspace('handleOpenFileWithResult', workspace => workspace.handleOpenFileWithResult(result));
        });
    },
    handleCloseFileFromUi: async (options) => {
        await withLoadedWorkspace('handleCloseFileFromUi', workspace => workspace.handleCloseFileFromUi(options));
    },
    handleExportDocx: async () => {
        await withLoadedWorkspace('handleExportDocx', workspace => workspace.handleExportDocx());
    },
    handleExportImages: async () => {
        await withLoadedWorkspace('handleExportImages', workspace => workspace.handleExportImages());
    },
    handleExportMultiPageTiff: async () => {
        await withLoadedWorkspace('handleExportMultiPageTiff', workspace => workspace.handleExportMultiPageTiff());
    },
    hasPdf,
    handleZoomIn: () => {
        void withLoadedWorkspace('handleZoomIn', workspace => workspace.handleZoomIn());
    },
    handleZoomOut: () => {
        void withLoadedWorkspace('handleZoomOut', workspace => workspace.handleZoomOut());
    },
    handleFitWidth: () => {
        void withLoadedWorkspace('handleFitWidth', workspace => workspace.handleFitWidth());
    },
    handleFitHeight: () => {
        void withLoadedWorkspace('handleFitHeight', workspace => workspace.handleFitHeight());
    },
    handleActualSize: () => {
        void withLoadedWorkspace('handleActualSize', workspace => workspace.handleActualSize());
    },
    handleViewModeSingle: () => {
        void withLoadedWorkspace('handleViewModeSingle', workspace => workspace.handleViewModeSingle());
    },
    handleViewModeFacing: () => {
        void withLoadedWorkspace('handleViewModeFacing', workspace => workspace.handleViewModeFacing());
    },
    handleViewModeFacingFirstSingle: () => {
        void withLoadedWorkspace('handleViewModeFacingFirstSingle', workspace => workspace.handleViewModeFacingFirstSingle());
    },
    handleDeletePages: () => {
        void withLoadedWorkspace('handleDeletePages', workspace => workspace.handleDeletePages());
    },
    handleExtractPages: () => {
        void withLoadedWorkspace('handleExtractPages', workspace => workspace.handleExtractPages());
    },
    handleRotateCw: () => {
        void withLoadedWorkspace('handleRotateCw', workspace => workspace.handleRotateCw());
    },
    handleRotateCcw: () => {
        void withLoadedWorkspace('handleRotateCcw', workspace => workspace.handleRotateCcw());
    },
    handleInsertPages: () => {
        void withLoadedWorkspace('handleInsertPages', workspace => workspace.handleInsertPages());
    },
    handleConvertToPdf: () => {
        void withLoadedWorkspace('handleConvertToPdf', workspace => workspace.handleConvertToPdf());
    },
    captureSplitPayload: () => {
        const workspace = mountedWorkspace.value;
        if (!workspace) {
            return Promise.resolve({kind: 'empty'} satisfies TSplitPayload);
        }
        return workspace.captureSplitPayload();
    },
    restoreSplitPayload: async (payload: TSplitPayload) => {
        if (!mountedWorkspace.value && payload.kind === 'empty') {
            return;
        }
        await withWorkspace('restoreSplitPayload', workspace => workspace.restoreSplitPayload(payload));
    },
    closeAllDropdowns: () => {
        void withLoadedWorkspace('closeAllDropdowns', workspace => workspace.closeAllDropdowns());
    },
};

defineExpose(workspaceExpose);
</script>

<style scoped>
.workspace-host {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
}

.workspace-host__placeholder {
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
}

.workspace-host__loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in oklab, var(--app-window-bg) 90%, var(--ui-bg-muted) 10%);
}

.workspace-host__spinner {
    width: 1.25rem;
    height: 1.25rem;
    animation: spin 1s linear infinite;
}


@keyframes spin {
    from {
        transform: rotate(0deg);
    }

    to {
        transform: rotate(360deg);
    }
}
</style>
