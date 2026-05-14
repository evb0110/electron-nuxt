<template>
    <div class="workspace-host">
        <div
            v-if="workspaceRequested && DocumentWorkspace"
            v-show="!isPlaceholderVisible"
            class="workspace-host__workspace"
        >
            <component
                :is="DocumentWorkspace"
                :key="workspaceRenderKey"
                ref="workspaceRef"
                :tab-id="tabId"
                :is-active="isActive && !isPlaceholderVisible"
                :is-render-active="isRenderActive && !isPlaceholderVisible"
                :is-tab-transition-busy="isTabTransitionBusy"
                :initial-view-state="initialViewState"
                :pending-document-open="isDocumentOpenInFlight"
                :start-section="startSection"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                @update-tab="handleUpdateTab"
                @update:start-section="handleStartSectionUpdate"
                @open-in-new-tab="handleOpenInNewTab"
                @request-close-tab="handleRequestCloseTab"
                @open-settings="handleOpenSettings"
                @open-combine="handleOpenCombine"
                @toggle-fullscreen="handleToggleFullscreen"
            />
        </div>

        <div v-if="isPlaceholderVisible" class="workspace-host__placeholder">
            <PdfEmptyState
                :recent-files="recentFiles"
                :recent-files-resolved="isResolved"
                :open-batch-progress="null"
                :open-in-progress="isOpenUiBusy"
                :start-section="startSection"
                can-combine-files
                @update:start-section="handleStartSectionUpdate"
                @open-file="handleOpenFileFromUi"
                @open-recent="handleOpenRecentFromPlaceholder"
                @remove-recent="handleRemoveRecentFromPlaceholder"
                @reveal-recent="handleRevealRecentFromPlaceholder"
                @clear-recent="handleClearRecentFromPlaceholder"
                @open-settings="handleOpenSettings"
                @combine-files="handleOpenCombine"
                @open-combine-result="handleOpenCombineResultFromPlaceholder"
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
            <div class="workspace-host__loading-chip">
                <AppSpinner size="md" tone="muted" />
                <span class="workspace-host__loading-label">{{ t('common.loading') }}</span>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platformApi';
import type { IRecentFile } from '@contracts/shared';
import type { TTabUpdate } from '@app/types/tabs';
import type { TSplitPayload } from '@contracts/windowTabs';
import {
    createDefaultWorkspaceToolbarSnapshot,
    type IWorkspaceExpose,
    type IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getPlatformAPI } from '@app/utils/platform';
import {
    getAsyncChunkLoadErrorMessage,
    shouldRetryAsyncChunkLoad,
} from '@app/modules/workspace-shell/composables/workspaceHostAsyncLoad';
import { isWorkspaceExpose } from '@app/modules/workspace-shell/composables/workspaceExposeContract';
import { useRecentFiles } from '@app/composables/useRecentFiles';
import AppSpinner from '@app/components/AppSpinner.vue';
import PdfEmptyState from '@app/components/pdf/PdfEmptyState.vue';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import {
    resolveWorkspaceRequestedState,
    shouldPreloadWorkspaceOnHostMount,
} from '@app/modules/workspace-shell/composables/workspaceHostMounting';
import {
    buildPendingTabDocumentHint,
    hasDocumentHintUpdate,
    isEmptyTabDocumentUpdate,
} from '@app/modules/workspace-shell/composables/workspaceTabDocumentHint';
import type { TStartSection } from '@app/types/startPage';
import {
    createTabViewSessionState,
    type ITabViewSessionState,
} from '@app/modules/workspace-shell/composables/useTabSessionStore';

const {
    hasDocumentHint = false,
    documentPath = null,
    isActive,
    isFullscreen,
    isRenderActive = isActive,
    isStartupOpenClaimPending = false,
    isTabTransitionBusy,
    fullscreenSupported,
    initialViewState = null,
    startSection = undefined,
    tabId,
} = defineProps<{
    tabId: string;
    isActive: boolean;
    isRenderActive?: boolean | undefined;
    isTabTransitionBusy: boolean;
    isStartupOpenClaimPending?: boolean | undefined;
    hasDocumentHint?: boolean | undefined;
    documentPath?: TDocumentRef | null | undefined;
    initialViewState?: ITabViewSessionState | null | undefined;
    startSection?: TStartSection | undefined;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
}>();
const { t } = useTypedI18n();

const emit = defineEmits<{
    'update-tab': [updates: TTabUpdate];
    'update-session-state': [state: ITabViewSessionState];
    'update:start-section': [section: TStartSection];
    'open-in-new-tab': [result: string | TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
}>();

function handleUpdateTab(updates: TTabUpdate) {
    if (activeDocumentOpenTransaction.value && isEmptyTabDocumentUpdate(updates)) {
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Suppressing empty workspace tab update during document open', {
            tabId: tabId,
            transactionId: activeDocumentOpenTransaction.value.id,
            action: activeDocumentOpenTransaction.value.action,
            target: activeDocumentOpenTransaction.value.target,
        });
        return;
    }

    emit('update-tab', updates);
}

function handleStartSectionUpdate(section: TStartSection) {
    emit('update:start-section', section);
}

function handleOpenInNewTab(result: string | TOpenFileResult) {
    emit('open-in-new-tab', result);
}

function handleRequestCloseTab() {
    emit('request-close-tab');
}

function handleOpenSettings() {
    emit('open-settings');
}

function handleOpenCombine() {
    emit('open-combine');
}

function handleToggleFullscreen() {
    emit('toggle-fullscreen');
}
const RECENT_OPEN_LOG_SECTION = 'recent-open';
const LOADER_LOG_SECTION = 'loader';
const DOCUMENT_OPEN_SETTLE_TIMEOUT_MS = 4_000;

interface IDocumentOpenTransaction {
    id: number;
    action: string;
    target: TTabUpdate | null;
    seededTabHint: boolean;
}

interface IDocumentOpenIntent {
    action: string;
    target?: TTabUpdate | null;
}

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
                tabId: tabId,
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
let nextDocumentOpenTransactionId = 0;
const activeDocumentOpenTransaction = ref<IDocumentOpenTransaction | null>(null);
const documentOpenInFlightCount = ref(0);
const filePickerInFlightCount = ref(0);
const workspaceSplitCache = useWorkspaceSplitCache();
const WORKSPACE_MOUNT_TIMEOUT_MS = 30_000;
const WORKSPACE_MOUNT_RETRY_TIMEOUT_MS = 20_000;
const restoredDocumentPaths = new Set<string>();

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
const workspaceRenderKey = computed(() => `${tabId}:${workspaceRenderNonce.value}`);
const workspaceVisibleDocument = computed(() => {
    const workspace = mountedWorkspace.value;
    if (!workspace) {
        return false;
    }

    const snapshot = workspace.getToolbarSnapshot();
    return snapshot.hasPdf || snapshot.isDjvuMode || snapshot.isOpeningDocument || snapshot.hasOpenError;
});
const hasPendingDocumentHint = computed(() => hasDocumentHint === true && !workspaceVisibleDocument.value);
const isPlaceholderVisible = computed(() => (
    !isDocumentOpenInFlight.value
    && isStartupOpenClaimPending !== true
    && !hasQueuedSplitRestore.value
    && !hasPendingDocumentHint.value
    && !workspaceVisibleDocument.value
));
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

const lastToolbarSnapshot = ref<IWorkspaceToolbarSnapshot>(createDefaultWorkspaceToolbarSnapshot());

function readWorkspaceToolbarSnapshot() {
    const workspace = mountedWorkspace.value;
    const isOpeningDocument = isDocumentOpenInFlight.value || hasPendingDocumentHint.value;
    if (isPlaceholderVisible.value) {
        lastToolbarSnapshot.value = createDefaultWorkspaceToolbarSnapshot();
        return {
            ...lastToolbarSnapshot.value,
            isOpeningDocument,
        };
    }

    if (!workspace) {
        if (workspaceRequested.value || isOpeningDocument || hasQueuedSplitRestore.value) {
            return {
                ...lastToolbarSnapshot.value,
                isOpeningDocument,
            };
        }

        lastToolbarSnapshot.value = createDefaultWorkspaceToolbarSnapshot();
        return lastToolbarSnapshot.value;
    }

    const workspaceSnapshot = workspace.getToolbarSnapshot();
    const snapshot = {
        ...workspaceSnapshot,
        isOpeningDocument: workspaceSnapshot.isOpeningDocument || isOpeningDocument,
    };
    lastToolbarSnapshot.value = snapshot;
    return snapshot;
}
const hasQueuedSplitRestore = computed(() => workspaceSplitCache.has(tabId));
const isDocumentOpenInFlight = computed(() => (
    documentOpenInFlightCount.value > 0
    || activeDocumentOpenTransaction.value !== null
));
const isFilePickerInFlight = computed(() => filePickerInFlightCount.value > 0);
const isOpenUiBusy = computed(() => isDocumentOpenInFlight.value || isFilePickerInFlight.value);
let documentOpenQueue: Promise<unknown> = Promise.resolve();
const shouldShowWorkspaceMountLoader = computed(() => isDocumentOpenInFlight.value);
const isHostErrorVisible = computed(() => (
    hasWorkspaceChunkLoadError.value
    && workspaceRequested.value
    && !hasMountedWorkspace.value
));
const isHostLoaderVisible = computed(() => (
    !isHostErrorVisible.value && (
        isStartupOpenClaimPending === true
    || isDocumentOpenInFlight.value
    || (workspaceRequested.value && hasPendingDocumentHint.value)
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

    if (isStartupOpenClaimPending === true) {
        return 'startup-open:claiming';
    }

    if (hasPendingDocumentHint.value && workspaceRequested.value && !isDocumentOpenInFlight.value) {
        return hasMountedWorkspace.value
            ? 'document-hint:awaiting-open'
            : 'document-hint:mounting-workspace';
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
        () => hasDocumentHint === true,
        () => isActive,
        () => isRenderActive,
    ],
    ([
        hasQueued,
        hasDocumentHint,
        isActive,
        isRenderActive,
    ]) => {
        workspaceRequested.value = resolveWorkspaceRequestedState(workspaceRequested.value, {
            hasQueuedSplitRestore: hasQueued,
            hasDocumentHint,
            isActive: isActive || isRenderActive,
        });
    },
    { immediate: true },
);

watch(loaderVariant, (nextVariant, previousVariant) => {
    if (nextVariant === previousVariant) {
        return;
    }

    BrowserLogger.debug(LOADER_LOG_SECTION, 'Workspace host loader variant changed', {
        tabId: tabId,
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

watch(
    [
        () => isActive,
        () => isRenderActive,
        () => documentPath,
        workspaceVisibleDocument,
        isDocumentOpenInFlight,
    ],
    ([
        active,
        renderActive,
        path,
        hasVisibleDocument,
        opening,
    ]) => {
        if (
            !(active || renderActive)
            || !path
            || hasDocumentHint !== true
            || hasVisibleDocument
            || opening
            || restoredDocumentPaths.has(path)
        ) {
            return;
        }

        restoredDocumentPaths.add(path);
        void enqueueDocumentOpen({
            action: 'restoreTabDocument',
            target: null,
        }, async () => openPath(path, 'restoreTabDocument'));
    },
    { immediate: true },
);

watch(hasMountedWorkspace, (mounted) => {
    if (
        !mounted
        || !(isActive || isRenderActive)
        || !initialViewState
        || !documentPath
        || activeDocumentOpenTransaction.value
        || workspaceHasOpenedDocument()
    ) {
        return;
    }

    void enqueueDocumentOpen({
        action: 'restoreColdDocument',
        target: buildPendingTabDocumentHint(documentPath),
    }, async () => withWorkspace(
        'restoreColdDocument',
        workspace => workspace.handleOpenFileDirectWithPersist(documentPath),
    ));
});

function handleRetryWorkspaceMount() {
    BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'Retrying DocumentWorkspace async chunk load', {tabId: tabId});

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

function workspaceHasDocumentOrOpenError() {
    const workspace = mountedWorkspace.value;
    if (!workspace) {
        return false;
    }

    const snapshot = workspace.getToolbarSnapshot();
    return snapshot.hasPdf || snapshot.isDjvuMode || snapshot.hasOpenError;
}

function workspaceHasOpenedDocument() {
    const workspace = mountedWorkspace.value;
    if (!workspace) {
        return false;
    }

    const snapshot = workspace.getToolbarSnapshot();
    return snapshot.hasPdf || snapshot.isDjvuMode;
}

function shouldSeedPendingTabHint(target: TTabUpdate | null | undefined) {
    return Boolean(
        target
        && hasDocumentHintUpdate(target)
        && !workspaceHasOpenedDocument(),
    );
}

function beginDocumentOpenTransaction(intent: IDocumentOpenIntent) {
    const target = intent.target ?? null;
    const transaction: IDocumentOpenTransaction = {
        id: ++nextDocumentOpenTransactionId,
        action: intent.action,
        target,
        seededTabHint: shouldSeedPendingTabHint(target),
    };

    activeDocumentOpenTransaction.value = transaction;

    if (transaction.seededTabHint && target) {
        emit('update-tab', target);
    }

    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Document open transaction started', {
        tabId: tabId,
        transactionId: transaction.id,
        action: transaction.action,
        seededTabHint: transaction.seededTabHint,
        target: transaction.target,
    });

    return transaction;
}

async function waitForDocumentOpenTerminalState(transaction: IDocumentOpenTransaction, opened: boolean) {
    await nextTick();

    if (!opened) {
        return;
    }

    const deadline = Date.now() + DOCUMENT_OPEN_SETTLE_TIMEOUT_MS;
    while (
        !isHostUnmounted
        && activeDocumentOpenTransaction.value?.id === transaction.id
        && Date.now() < deadline
    ) {
        const workspace = mountedWorkspace.value;
        if (workspace) {
            const remainingMs = Math.max(0, deadline - Date.now());
            if (remainingMs > 0) {
                await Promise.race([
                    workspace.waitForDocumentOpenSettled(),
                    new Promise<void>((resolve) => {
                        setTimeout(resolve, remainingMs);
                    }),
                ]);
            }

            if (workspaceHasDocumentOrOpenError()) {
                return;
            }
        } else {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 25);
            });
        }
    }

    if (!workspaceHasDocumentOrOpenError()) {
        BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Document open did not reach a terminal visible state before settle timeout', {
            tabId: tabId,
            transactionId: transaction.id,
            action: transaction.action,
            target: transaction.target,
            timeoutMs: DOCUMENT_OPEN_SETTLE_TIMEOUT_MS,
            hasMountedWorkspace: hasMountedWorkspace.value,
        });
    }
}

function finishDocumentOpenTransaction(transaction: IDocumentOpenTransaction, opened: boolean) {
    if (!opened && transaction.seededTabHint && !workspaceHasDocumentOrOpenError()) {
        emit('update-tab', {
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        });
    }

    if (activeDocumentOpenTransaction.value?.id === transaction.id) {
        activeDocumentOpenTransaction.value = null;
    }

    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Document open transaction finished', {
        tabId: tabId,
        transactionId: transaction.id,
        action: transaction.action,
        opened,
        hasTerminalDocumentState: workspaceHasDocumentOrOpenError(),
    });
}

async function runWithDocumentOpenInFlight<T>(
    intent: IDocumentOpenIntent,
    run: () => Promise<T>,
) {
    const transaction = beginDocumentOpenTransaction(intent);
    documentOpenInFlightCount.value += 1;
    let result: T | undefined;
    let didThrow = false;
    try {
        result = await run();
        return result;
    } catch (error) {
        didThrow = true;
        throw error;
    } finally {
        const opened = !didThrow && result !== false;
        try {
            await waitForDocumentOpenTerminalState(transaction, opened);
        } finally {
            finishDocumentOpenTransaction(transaction, opened);
            documentOpenInFlightCount.value = Math.max(0, documentOpenInFlightCount.value - 1);
        }
    }
}

async function enqueueDocumentOpen<T>(
    intent: IDocumentOpenIntent,
    run: () => Promise<T>,
) {
    const queuedRun = documentOpenQueue
        .catch(() => {})
        .then(() => runWithDocumentOpenInFlight(intent, run));
    documentOpenQueue = queuedRun.catch(() => {});
    return queuedRun;
}

async function pickFileFromUi() {
    filePickerInFlightCount.value += 1;
    try {
        await nextTick();
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => resolve());
            });
        });
        return await getPlatformAPI().documents.openPdfDialog();
    } finally {
        filePickerInFlightCount.value = Math.max(0, filePickerInFlightCount.value - 1);
    }
}

async function preloadWorkspaceComponent(reason: string) {
    if (workspacePreloadPromise) {
        return workspacePreloadPromise;
    }

    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Preloading DocumentWorkspace chunk', {
        tabId: tabId,
        reason,
    });

    workspacePreloadPromise = loadDocumentWorkspace()
        .then(() => {
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'DocumentWorkspace chunk preloaded', {
                tabId: tabId,
                reason,
            });
            return true;
        })
        .catch((error) => {
            BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'Failed to preload DocumentWorkspace chunk', {
                tabId: tabId,
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
            tabId: tabId,
            reason,
        });
    }

    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Requesting workspace mount', {
        tabId: tabId,
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
                tabId: tabId,
                reason,
                error: workspaceChunkLoadError.value,
            });
        } else {
            BrowserLogger.error('workspace-host', 'Workspace load timed out', {
                tabId: tabId,
                reason,
            });
        }
    } else {
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Workspace mount ready', {
            tabId: tabId,
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
            tabId: tabId,
            error,
        });
    }
}

async function withWorkspace(
    action: string,
    run: (workspace: IWorkspaceExpose) => Promise<boolean | undefined> | boolean | undefined,
) {
    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'withWorkspace start', {
        tabId: tabId,
        action,
        hasMountedWorkspace: hasMountedWorkspace.value,
        workspaceRequested: workspaceRequested.value,
    });

    let workspace = mountedWorkspace.value ?? await ensureWorkspaceLoaded(action);
    if (!workspace) {
        if (hasWorkspaceChunkLoadError.value) {
            BrowserLogger.warn('workspace-host', 'Workspace unavailable due to async chunk load failure', {
                tabId: tabId,
                action,
                error: workspaceChunkLoadError.value,
            });
            return false;
        }
        workspace = await waitForWorkspaceMount(WORKSPACE_MOUNT_RETRY_TIMEOUT_MS);
    }
    if (!workspace) {
        BrowserLogger.error('workspace-host', 'Workspace unavailable for action', {
            tabId: tabId,
            action,
        });
        return false;
    }

    try {
        const result = await run(workspace);
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'withWorkspace completed', {
            tabId: tabId,
            action,
            hasPdf: workspaceHasPdf(workspace),
            handled: result !== false,
        });
        return result !== false;
    } catch (error) {
        BrowserLogger.error('workspace-host', `Action failed (${action})`, {
            tabId: tabId,
            error,
        });
        return false;
    }
}

async function openPath(path: TDocumentRef, action: string) {
    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Attempting open path', {
        tabId: tabId,
        action,
        path,
    });
    return withWorkspace(action, workspace => workspace.handleOpenFileDirectWithPersist(path));
}

async function handleOpenRecentFromPlaceholder(file: IRecentFile) {
    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Recent item clicked from placeholder', {
        tabId: tabId,
        path: file.originalPath,
        workspaceRequested: workspaceRequested.value,
        hasMountedWorkspace: hasMountedWorkspace.value,
    });

    return enqueueDocumentOpen({
        action: 'openRecentFromPlaceholder',
        target: buildPendingTabDocumentHint(file),
    }, async () => {
        const preloadedWorkspace = mountedWorkspace.value ?? await ensureWorkspaceLoaded('openRecentFromPlaceholder:preload');
        if (!preloadedWorkspace) {
            BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'Failed to preload workspace for recent open', {
                tabId: tabId,
                path: file.originalPath,
            });
            return false;
        }

        return withWorkspace('openRecentFromPlaceholder', workspace => workspace.openRecentFile(file));
    });
}

async function handleRemoveRecentFromPlaceholder(file: IRecentFile) {
    await removeRecentFile(file);
}

async function handleRevealRecentFromPlaceholder(file: IRecentFile) {
    try {
        await getPlatformAPI().documents.showItemInFolder(file.originalPath);
    } catch {
        // Best-effort; ignore failures (path may have moved or permissions changed).
    }
}

async function handleClearRecentFromPlaceholder() {
    await clearRecentFiles();
}

async function handleOpenCombineResultFromPlaceholder(result: TOpenFileResult) {
    return enqueueDocumentOpen({
        action: 'openCombineResultFromPlaceholder',
        target: buildPendingTabDocumentHint(result),
    }, async () => withWorkspace(
        'openCombineResultFromPlaceholder',
        workspace => workspace.handleOpenFileWithResult(result),
    ));
}

async function handleOpenFileFromUi() {
    const result = await pickFileFromUi();
    if (!result) {
        return false;
    }

    return enqueueDocumentOpen({
        action: 'handleOpenFileWithResultFromUi',
        target: buildPendingTabDocumentHint(result),
    }, async () => withWorkspace(
        'handleOpenFileWithResultFromUi',
        workspace => workspace.handleOpenFileWithResult(result),
    ));
}

onMounted(() => {
    isHostUnmounted = false;
    if (shouldPreloadWorkspaceOnHostMount({
        hasQueuedSplitRestore: hasQueuedSplitRestore.value,
        hasDocumentHint: hasDocumentHint === true,
        isActive: isActive || isRenderActive,
        isDev: import.meta.dev,
    })) {
        void preloadWorkspaceComponent('workspace-host-mounted');
    }

    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Workspace host mounted; loading recent files', {tabId: tabId});
    void loadRecentFiles().finally(() => {
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Workspace host recent files load settled', {
            tabId: tabId,
            count: recentFiles.value.length,
        });
    });
});

onUnmounted(() => {
    emit('update-session-state', createTabViewSessionState(readWorkspaceToolbarSnapshot()));
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
    handlePrintCurrentPage: async () => {
        await withLoadedWorkspace('handlePrintCurrentPage', workspace => workspace.handlePrintCurrentPage());
    },
    handleUndo: () => {
        void withLoadedWorkspace('handleUndo', workspace => workspace.handleUndo());
    },
    handleRedo: () => {
        void withLoadedWorkspace('handleRedo', workspace => workspace.handleRedo());
    },
    handleOpenFileFromUi,
    handleCombineImages: async () => {
        const workspace = mountedWorkspace.value;
        if (!workspace) {
            return false;
        }
        try {
            return await workspace.handleCombineImages();
        } catch (error) {
            BrowserLogger.error('workspace-host', 'Action failed (handleCombineImages)', {
                tabId: tabId,
                error,
            });
            return false;
        }
    },
    handleOpenFileDirectWithPersist: async (path: string) => {
        return enqueueDocumentOpen({
            action: 'handleOpenFileDirectWithPersist',
            target: buildPendingTabDocumentHint(path),
        }, async () => openPath(path, 'handleOpenFileDirectWithPersist'));
    },
    handleOpenFileDirectBatchWithPersist: async (paths: string[]) => {
        return enqueueDocumentOpen({
            action: 'handleOpenFileDirectBatchWithPersist',
            target: null,
        }, async () => (
            withWorkspace(
                'handleOpenFileDirectBatchWithPersist',
                workspace => workspace.handleOpenFileDirectBatchWithPersist(paths),
            )
        ));
    },
    handleOpenFileWithResult: async (result: TOpenFileResult) => {
        return enqueueDocumentOpen({
            action: 'handleOpenFileWithResult',
            target: buildPendingTabDocumentHint(result),
        }, async () => withWorkspace(
            'handleOpenFileWithResult',
            workspace => workspace.handleOpenFileWithResult(result),
        ));
    },
    handleCloseFileFromUi: async (options) => {
        await withLoadedWorkspace('handleCloseFileFromUi', workspace => workspace.handleCloseFileFromUi(options));
    },
    openRecentFile: async (file: IRecentFile) => {
        return enqueueDocumentOpen({
            action: 'openRecentFile',
            target: buildPendingTabDocumentHint(file),
        }, async () => withWorkspace('openRecentFile', workspace => workspace.openRecentFile(file)));
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
            await withWorkspace('restoreSplitPayload', async (workspace) => {
                await workspace.restoreSplitPayload(payload);
                return true;
            });
        };

        if (payload.kind === 'empty') {
            await restorePayload();
            return;
        }

        await enqueueDocumentOpen({
            action: 'restoreSplitPayload',
            target: null,
        }, restorePayload);
    },
    closeAllDropdowns: () => {
        void withLoadedWorkspace('closeAllDropdowns', workspace => workspace.closeAllDropdowns());
    },
    waitForDocumentOpenSettled: async () => {
        await withLoadedWorkspace('waitForDocumentOpenSettled', workspace => workspace.waitForDocumentOpenSettled());
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

.workspace-host__workspace {
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
}

.workspace-host__loading {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    background: transparent;
}

.workspace-host__loading-chip {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
}

.workspace-host__loading-label {
    color: var(--ui-text-muted);
    font-size: 0.875rem;
    line-height: 1.25rem;
}
</style>
