<template>
    <div class="workspace-host">
        <component
            :is="DocumentWorkspace"
            v-if="workspaceRequested && DocumentWorkspace"
            :key="workspaceRenderKey"
            ref="workspaceRef"
            :tab-id="tabId"
            :is-active="isActive"
            :is-tab-transition-busy="isTabTransitionBusy"
            :pending-document-open="isDocumentOpenInFlight"
            @update-tab="(updates) => emit('update-tab', updates)"
            @open-in-new-tab="(result) => emit('open-in-new-tab', result)"
            @request-close-tab="emit('request-close-tab')"
            @open-settings="emit('open-settings')"
        />

        <div v-else class="workspace-host__placeholder">
            <PdfEmptyState
                :recent-files="recentFiles"
                :recent-files-resolved="isResolved"
                :open-batch-progress="null"
                :open-in-progress="isDocumentOpenInFlight"
                @open-file="handleOpenFileFromUi"
                @open-recent="handleOpenRecentFromPlaceholder"
                @remove-recent="handleRemoveRecentFromPlaceholder"
                @clear-recent="handleClearRecentFromPlaceholder"
            />
        </div>

        <div
            v-if="isHostErrorVisible"
            class="workspace-host__loading"
            role="alert"
            aria-live="assertive"
        >
            <div class="flex max-w-sm flex-col items-center gap-3 px-4 text-center">
                <span class="text-sm font-medium text-[var(--ui-text-highlighted)]">
                    {{ t('errors.workspace.loadTitle') }}
                </span>
                <p class="text-sm text-[var(--ui-text-muted)]">
                    {{ workspaceLoadErrorDescription }}
                </p>
                <UButton
                    color="neutral"
                    variant="outline"
                    :label="t('common.retry')"
                    @click="handleRetryWorkspaceMount"
                />
            </div>
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
import type { TOpenFileResult } from '@contracts/platform-api';
import type { IRecentFile } from '@contracts/shared';
import type { TTabUpdate } from '@app/types/tabs';
import type { TSplitPayload } from '@contracts/window-tabs';
import type {
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspace-expose';
import { BrowserLogger } from '@app/utils/browser-logger';
import { getPlatformAPI } from '@app/utils/platform';
import {
    getAsyncChunkLoadErrorMessage,
    shouldRetryAsyncChunkLoad,
} from '@app/modules/workspace-shell/composables/workspace-host-async-load';
import { handleWorkspaceHostOpenFileFromUi } from '@app/modules/workspace-shell/composables/workspace-host-open';
import { isWorkspaceExpose } from '@app/modules/workspace-shell/composables/workspace-expose-contract';
import { useRecentFiles } from '@app/composables/useRecentFiles';
import PdfEmptyState from '@app/components/pdf/PdfEmptyState.vue';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import { resolveWorkspaceRequestedState } from '@app/modules/workspace-shell/composables/workspace-host-mounting';

const props = defineProps<{
    tabId: string;
    isActive: boolean;
    isTabTransitionBusy: boolean;
    hasDocumentHint?: boolean;
}>();
const { t } = useTypedI18n();

const emit = defineEmits<{
    'update-tab': [updates: TTabUpdate];
    'open-in-new-tab': [result: string | TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
}>();
const RECENT_OPEN_LOG_SECTION = 'recent-open';
const LOADER_LOG_SECTION = 'loader';

const loadDocumentWorkspace = () => import('@app/modules/workspace-shell/components/DocumentWorkspace.vue');
const workspaceChunkLoadError = ref<unknown>(null);
const workspaceRenderNonce = ref(0);
const chunkRetryTimers = new Set<ReturnType<typeof setTimeout>>();

const DocumentWorkspace = import.meta.client
    ? defineAsyncComponent({
        loader: loadDocumentWorkspace,
        suspensible: false,
        onError: (error, retry, fail, attempts) => {
            BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'DocumentWorkspace async chunk load failed', {
                tabId: props.tabId,
                attempts,
                error,
            });

            if (shouldRetryAsyncChunkLoad({
                attempts,
                error,
                isDev: import.meta.dev,
            })) {
                const retryDelayMs = attempts * 150;
                const retryTimer = setTimeout(() => {
                    chunkRetryTimers.delete(retryTimer);
                    retry();
                }, retryDelayMs);
                chunkRetryTimers.add(retryTimer);
                return;
            }

            workspaceChunkLoadError.value = error;
            fail();
        },
    })
    : null;

const workspaceRequested = ref(false);
const workspaceRef = ref<unknown>(null);
let workspaceLoadPromise: Promise<IWorkspaceExpose | null> | null = null;
let workspacePreloadPromise: Promise<boolean> | null = null;
let isHostUnmounted = false;
const documentOpenInFlightCount = ref(0);
const workspaceSplitCache = useWorkspaceSplitCache();
const WORKSPACE_MOUNT_TIMEOUT_MS = 30_000;
const WORKSPACE_MOUNT_RETRY_TIMEOUT_MS = 20_000;

const {
    recentFiles,
    isResolved,
    loadRecentFiles,
    removeRecentFile,
    clearRecentFiles,
} = useRecentFiles();

const mountedWorkspace = computed<IWorkspaceExpose | null>(() => (
    isWorkspaceExpose(workspaceRef.value) ? workspaceRef.value : null
));
const hasMountedWorkspace = computed(() => mountedWorkspace.value !== null);
const hasWorkspaceChunkLoadError = computed(() => workspaceChunkLoadError.value !== null);
const workspaceRenderKey = computed(() => `${props.tabId}:${workspaceRenderNonce.value}`);
const workspaceLoadErrorDescription = computed(() => {
    const message = getAsyncChunkLoadErrorMessage(workspaceChunkLoadError.value).trim();
    if (!message) {
        return t('errors.workspace.loadDescription');
    }
    return t('errors.workspace.loadDescriptionWithMessage', { message });
});

const hasPdf = computed<boolean>(() => {
    const value = mountedWorkspace.value?.hasPdf;
    if (typeof value === 'boolean') {
        return value;
    }
    return value?.value ?? false;
});

function createEmptyToolbarSnapshot(): IWorkspaceToolbarSnapshot {
    return {
        hasPdf: false,
        isOpeningDocument: false,
        isPreparingPrint: false,
        canSave: false,
        canUndo: false,
        canRedo: false,
        canExportDocx: false,
        isSaving: false,
        isSavingAs: false,
        isAnySaving: false,
        isHistoryBusy: false,
        isExportingDocx: false,
        isFitWidthActive: false,
        isFitHeightActive: false,
        showSidebar: false,
        dragMode: false,
        continuousScroll: false,
        isDjvuMode: false,
        isCapturingRegion: false,
        isCropSelecting: false,
        isPlacingPageNote: false,
        zoom: 1,
        effectiveZoom: 1,
        zoomMode: 'fit-width',
        fitMode: 'width',
        viewMode: 'single',
        currentPage: 1,
        totalPages: 0,
    };
}

const lastToolbarSnapshot = ref<IWorkspaceToolbarSnapshot>(createEmptyToolbarSnapshot());

function readWorkspaceToolbarSnapshot() {
    const workspace = mountedWorkspace.value;
    if (!workspace) {
        if (workspaceRequested.value || isDocumentOpenInFlight.value || hasQueuedSplitRestore.value) {
            return {
                ...lastToolbarSnapshot.value,
                isOpeningDocument: isDocumentOpenInFlight.value,
            };
        }

        lastToolbarSnapshot.value = createEmptyToolbarSnapshot();
        return lastToolbarSnapshot.value;
    }

    const workspaceSnapshot = workspace.getToolbarSnapshot();
    const snapshot = {
        ...workspaceSnapshot,
        isOpeningDocument: workspaceSnapshot.isOpeningDocument || isDocumentOpenInFlight.value,
    };
    lastToolbarSnapshot.value = snapshot;
    return snapshot;
}
const hasQueuedSplitRestore = computed(() => workspaceSplitCache.has(props.tabId));
const isDocumentOpenInFlight = computed(() => documentOpenInFlightCount.value > 0);
let documentOpenQueue: Promise<void> = Promise.resolve();
const shouldShowWorkspaceMountLoader = computed(() => isDocumentOpenInFlight.value);
const isHostErrorVisible = computed(() => (
    hasWorkspaceChunkLoadError.value
    && workspaceRequested.value
    && !hasMountedWorkspace.value
));
const isHostLoaderVisible = computed(() => (
    !isHostErrorVisible.value && (
        isDocumentOpenInFlight.value
    || (workspaceRequested.value && !hasMountedWorkspace.value && shouldShowWorkspaceMountLoader.value)
    )
));
const loaderVariant = computed(() => {
    if (isHostErrorVisible.value) {
        return 'workspace-mount:error';
    }

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

    BrowserLogger.debug(LOADER_LOG_SECTION, 'Workspace host loader variant changed', {
        tabId: props.tabId,
        previousVariant,
        nextVariant,
        spinnerSizeRem: 1.25,
        isDocumentOpenInFlight: isDocumentOpenInFlight.value,
        workspaceRequested: workspaceRequested.value,
        hasMountedWorkspace: hasMountedWorkspace.value,
        hasWorkspaceChunkLoadError: hasWorkspaceChunkLoadError.value,
    });
}, { immediate: true });

watch(hasMountedWorkspace, (mounted) => {
    if (mounted) {
        workspaceChunkLoadError.value = null;
    }
});

function handleRetryWorkspaceMount() {
    BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'Retrying DocumentWorkspace async chunk load', {tabId: props.tabId});

    workspaceChunkLoadError.value = null;
    workspaceRenderNonce.value += 1;
    workspaceLoadPromise = null;
    workspaceRequested.value = true;
    void preloadWorkspaceComponent('manual-retry');
}

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

async function enqueueDocumentOpen(run: () => Promise<void>) {
    const queuedRun = documentOpenQueue
        .catch(() => {})
        .then(() => runWhileOpeningDocument(run));
    documentOpenQueue = queuedRun.catch(() => {});
    await queuedRun;
}

async function preloadWorkspaceComponent(reason: string) {
    if (workspacePreloadPromise) {
        return workspacePreloadPromise;
    }

    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Preloading DocumentWorkspace chunk', {
        tabId: props.tabId,
        reason,
    });

    workspacePreloadPromise = loadDocumentWorkspace()
        .then(() => {
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'DocumentWorkspace chunk preloaded', {
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
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (isHostUnmounted) {
            return null;
        }
        if (hasWorkspaceChunkLoadError.value) {
            return null;
        }
        if (mountedWorkspace.value) {
            return mountedWorkspace.value;
        }

        await new Promise<void>((resolve) => {
            setTimeout(resolve, 25);
        });
    }
    return null;
}

async function ensureWorkspaceLoaded(reason: string) {
    if (mountedWorkspace.value) {
        return mountedWorkspace.value;
    }
    if (hasWorkspaceChunkLoadError.value) {
        return null;
    }

    const preloadSucceeded = await preloadWorkspaceComponent(`ensureWorkspaceLoaded:${reason}`);
    if (!preloadSucceeded) {
        BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Proceeding with workspace mount after preload failure', {
            tabId: props.tabId,
            reason,
        });
    }

    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Requesting workspace mount', {
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
        if (hasWorkspaceChunkLoadError.value) {
            BrowserLogger.error('workspace-host', 'Workspace load failed due to async chunk error', {
                tabId: props.tabId,
                reason,
                error: workspaceChunkLoadError.value,
            });
        } else {
            BrowserLogger.error('workspace-host', 'Workspace load timed out', {
                tabId: props.tabId,
                reason,
            });
        }
    } else {
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Workspace mount ready', {
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
    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'withWorkspace start', {
        tabId: props.tabId,
        action,
        hasMountedWorkspace: hasMountedWorkspace.value,
        workspaceRequested: workspaceRequested.value,
    });

    let workspace = mountedWorkspace.value ?? await ensureWorkspaceLoaded(action);
    if (!workspace) {
        if (hasWorkspaceChunkLoadError.value) {
            BrowserLogger.warn('workspace-host', 'Workspace unavailable due to async chunk load failure', {
                tabId: props.tabId,
                action,
                error: workspaceChunkLoadError.value,
            });
            return;
        }
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
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'withWorkspace completed', {
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
    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Attempting open path', {
        tabId: props.tabId,
        action,
        path,
    });
    await withWorkspace(action, workspace => workspace.handleOpenFileDirectWithPersist(path));
}

async function handleOpenRecentFromPlaceholder(file: IRecentFile) {
    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Recent item clicked from placeholder', {
        tabId: props.tabId,
        path: file.originalPath,
        workspaceRequested: workspaceRequested.value,
        hasMountedWorkspace: hasMountedWorkspace.value,
    });

    await enqueueDocumentOpen(async () => {
        const preloadedWorkspace = mountedWorkspace.value ?? await ensureWorkspaceLoaded('openRecentFromPlaceholder:preload');
        if (!preloadedWorkspace) {
            BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'Failed to preload workspace for recent open', {
                tabId: props.tabId,
                path: file.originalPath,
            });
            return;
        }

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
    await enqueueDocumentOpen(async () => {
        await handleWorkspaceHostOpenFileFromUi({
            mountedWorkspace: mountedWorkspace.value,
            pickFileToOpen: () => getPlatformAPI().documents.openPdfDialog(),
            withWorkspace,
        });
    });
}

onMounted(() => {
    isHostUnmounted = false;
    void preloadWorkspaceComponent('workspace-host-mounted');

    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Workspace host mounted; loading recent files', {tabId: props.tabId});
    void loadRecentFiles().finally(() => {
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Workspace host recent files load settled', {
            tabId: props.tabId,
            count: recentFiles.value.length,
        });
    });
});

onUnmounted(() => {
    isHostUnmounted = true;
    workspaceLoadPromise = null;
    workspacePreloadPromise = null;
    for (const timer of chunkRetryTimers) {
        clearTimeout(timer);
    }
    chunkRetryTimers.clear();
});

const workspaceExpose: IWorkspaceExpose = {
    handleSave: async () => {
        await withLoadedWorkspace('handleSave', workspace => workspace.handleSave());
    },
    handleSaveAs: async () => {
        await withLoadedWorkspace('handleSaveAs', workspace => workspace.handleSaveAs());
    },
    handlePrint: async () => {
        await withLoadedWorkspace('handlePrint', workspace => workspace.handlePrint());
    },
    handleUndo: () => {
        void withLoadedWorkspace('handleUndo', workspace => workspace.handleUndo());
    },
    handleRedo: () => {
        void withLoadedWorkspace('handleRedo', workspace => workspace.handleRedo());
    },
    handleOpenFileFromUi,
    handleCombineImages: async () => {
        await withLoadedWorkspace('handleCombineImages', workspace => workspace.handleCombineImages());
    },
    handleOpenFileDirectWithPersist: async (path: string) => {
        await enqueueDocumentOpen(async () => {
            await openPath(path, 'handleOpenFileDirectWithPersist');
        });
    },
    handleOpenFileDirectBatchWithPersist: async (paths: string[]) => {
        await enqueueDocumentOpen(async () => {
            await withWorkspace(
                'handleOpenFileDirectBatchWithPersist',
                workspace => workspace.handleOpenFileDirectBatchWithPersist(paths),
            );
        });
    },
    handleOpenFileWithResult: async (result: TOpenFileResult) => {
        await enqueueDocumentOpen(async () => {
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
    handleToggleSidebar: () => {
        void withLoadedWorkspace('handleToggleSidebar', workspace => workspace.handleToggleSidebar());
    },
    handleToggleContinuousScroll: () => {
        void withLoadedWorkspace('handleToggleContinuousScroll', workspace => workspace.handleToggleContinuousScroll());
    },
    handleEnableDragMode: () => {
        void withLoadedWorkspace('handleEnableDragMode', workspace => workspace.handleEnableDragMode());
    },
    handleDisableDragMode: () => {
        void withLoadedWorkspace('handleDisableDragMode', workspace => workspace.handleDisableDragMode());
    },
    handleCaptureRegion: () => {
        void withLoadedWorkspace('handleCaptureRegion', workspace => workspace.handleCaptureRegion());
    },
    handleQuickNote: () => {
        void withLoadedWorkspace('handleQuickNote', workspace => workspace.handleQuickNote());
    },
    handleInsertImageFromFile: async () => {
        await withLoadedWorkspace('handleInsertImageFromFile', workspace => workspace.handleInsertImageFromFile());
    },
    handlePasteImageFromClipboard: async () => {
        await withLoadedWorkspace(
            'handlePasteImageFromClipboard',
            workspace => workspace.handlePasteImageFromClipboard(),
        );
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
        const restorePayload = async () => {
            await withWorkspace('restoreSplitPayload', workspace => workspace.restoreSplitPayload(payload));
        };

        if (payload.kind === 'empty') {
            await restorePayload();
            return;
        }

        await runWhileOpeningDocument(restorePayload);
    },
    closeAllDropdowns: () => {
        void withLoadedWorkspace('closeAllDropdowns', workspace => workspace.closeAllDropdowns());
    },
    getToolbarSnapshot: () => readWorkspaceToolbarSnapshot(),
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
