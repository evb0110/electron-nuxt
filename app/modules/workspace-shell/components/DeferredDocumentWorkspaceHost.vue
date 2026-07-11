<template>
    <div class="workspace-host">
        <div
            v-if="workspaceRequested && DocumentWorkspace && !hasWorkspaceChunkLoadError"
            v-show="!isPlaceholderVisible"
            class="workspace-host__workspace"
        >
            <component
                :is="DocumentWorkspace"
                :key="workspaceRenderKey"
                :tab-id="tabId"
                :is-active="isActive && !isPlaceholderVisible"
                :is-render-active="isRenderActive && !isPlaceholderVisible"
                :is-tab-transition-busy="isTabTransitionBusy"
                :initial-view-state="initialViewState"
                :pending-document-open="isDocumentOpenInFlight"
                :pending-document-path="pendingDocumentPath"
                :document-session="activeDocumentSession"
                :split-cache-session="splitCacheSession"
                :start-section="startSection"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                :is-workspace-layout-resizing="isWorkspaceLayoutResizing"
                @update-document-record="handleDocumentRecordUpdate"
                @update:start-section="handleStartSectionUpdate"
                @open-in-new-tab="handleOpenInNewTab"
                @request-close-tab="handleRequestCloseTab"
                @open-settings="handleOpenSettings"
                @open-combine="handleOpenCombine"
                @toggle-fullscreen="handleToggleFullscreen"
                @expose-ready="handleWorkspaceExposeReady"
                @expose-released="handleWorkspaceExposeReleased"
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
                :open-combine-result="handleOpenCombineResultFromPlaceholder"
                @update:start-section="handleStartSectionUpdate"
                @open-file="handleOpenFileFromUi"
                @open-recent="handleOpenRecentFromPlaceholder"
                @remove-recent="handleRemoveRecentFromPlaceholder"
                @reveal-recent="handleRevealRecentFromPlaceholder"
                @clear-recent="handleClearRecentFromPlaceholder"
                @open-settings="handleOpenSettings"
                @combine-files="handleOpenCombine"
            />
        </div>

        <WorkspaceHostDocumentOpenFallback
            v-if="showHostDocumentOpenSkeleton"
            :path="pendingDocumentPath"
        />

        <DocumentWorkspaceFailurePanel
            v-if="isHostErrorVisible"
            :description="workspaceLoadErrorDescription"
            @close="handleRequestCloseTab"
            @retry="handleRetryWorkspaceMount"
        />

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
import { delay } from 'es-toolkit/promise';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { IRecentFile } from '@contracts/shared';
import type { TTabUpdate } from '@app/types/tabs';
import {
    createDefaultWorkspaceToolbarSnapshot,
    type IWorkspaceExpose,
    type IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import { BrowserLogger } from '@app/utils/browserLogger';
import * as platformDocuments from '@app/utils/platformDocuments';
import { getAsyncChunkLoadErrorMessage } from '@app/modules/workspace-shell/host/getAsyncChunkLoadErrorMessage';
import { useRecentFiles } from '@app/composables/useRecentFiles';
import AppSpinner from '@app/components/AppSpinner.vue';
import { PdfEmptyState } from '@app/modules/pdf-viewer/public/component-exports/pdfEmptyState';
import WorkspaceHostDocumentOpenFallback from '@app/modules/workspace-shell/components/WorkspaceHostDocumentOpenFallback.vue';
import DocumentWorkspaceFailurePanel from '@app/modules/workspace-shell/components/DocumentWorkspaceFailurePanel.vue';
import { handleDocumentWorkspaceCrash } from '@app/modules/workspace-shell/checkpoint/handleDocumentWorkspaceCrash';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import { resolveWorkspaceRequestedState } from '@app/modules/workspace-shell/host/resolveWorkspaceRequestedState';
import { shouldPreloadWorkspaceOnHostMount } from '@app/modules/workspace-shell/host/shouldPreloadWorkspaceOnHostMount';
import { shouldShowWorkspaceHostLoader } from '@app/modules/workspace-shell/host/shouldShowWorkspaceHostLoader';
import { shouldShowWorkspacePlaceholder } from '@app/modules/workspace-shell/host/shouldShowWorkspacePlaceholder';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/tabs/tabHasDocumentHint';
import {
    createWorkspaceRestoreAttemptState,
    finishWorkspaceRestoreAttempt,
    tryClaimWorkspaceRestoreAttempt,
    workspaceHasDocumentOrOpenError as getWorkspaceHasDocumentOrOpenError,
    workspaceHasOpenedDocument as getWorkspaceHasOpenedDocument,
    workspaceSessionHasOpenedDocument as getWorkspaceSessionHasOpenedDocument,
} from '@app/modules/workspace-shell/host/deferredWorkspaceHostState';
import { buildPendingTabDocumentHint } from '@app/modules/workspace-shell/tabs/buildPendingTabDocumentHint';
import { hasWorkspaceViewerDocumentCapabilities } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import { workspaceHasPdf } from '@app/modules/workspace-shell/state/workspaceHasPdf';
import { createDeferredWorkspaceExposeProxy } from '@app/modules/workspace-shell/expose/createDeferredWorkspaceExposeProxy';
import type { TStartSection } from '@app/types/startSection';
import { createTabViewSessionState } from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import {
    createPendingWorkspaceDocumentRecord,
    createWorkspaceDocumentRecord,
    type IWorkspaceDocumentRecord,
} from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { createWorkspaceDocumentSessionCore } from '@app/modules/workspace-shell/document-sessions/createWorkspaceDocumentSessionCore';
import { createWorkspaceSplitCacheSessionState } from '@app/modules/workspace-shell/document-sessions/createWorkspaceSplitCacheSessionState';
import type {
    IWorkspaceDocumentSessionController,
    IWorkspaceDocumentSessionSnapshot,
} from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';
import { useDeferredWorkspaceChunkLoader } from '@app/modules/workspace-shell/composables/useDeferredWorkspaceChunkLoader';
import {
    createDeferredWorkspaceHostBindings,
    type IDeferredWorkspaceHostEmits,
} from '@app/modules/workspace-shell/composables/createDeferredWorkspaceHostBindings';
import { DEFERRED_WORKSPACE_HOST_POLICY } from '@app/modules/workspace-shell/host/deferredWorkspaceHostPolicy';
import {
    type IDocumentOpenIntent,
    type IDocumentOpenTransactionRun,
    resolveDocumentOpenRunResult,
    resolveDocumentOpenTransactionKind,
    resolveTransactionDocumentRef,
    shouldSeedPendingTabHint as shouldSeedPendingTabHintForDocumentOpen,
} from '@app/modules/workspace-shell/host/deferredWorkspaceHostDocumentOpen';

const {
    hasDocumentHint = false,
    documentPath = null,
    documentRecord = null,
    documentSession = null,
    isActive,
    isFullscreen,
    isRenderActive = isActive,
    isStartupOpenClaimPending = false,
    isTabTransitionBusy,
    isWorkspaceLayoutResizing = false,
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
    documentRecord?: IWorkspaceDocumentRecord | null | undefined;
    documentSession?: IWorkspaceDocumentSessionController | null | undefined;
    initialViewState?: ITabViewSessionState | null | undefined;
    startSection?: TStartSection | undefined;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
    isWorkspaceLayoutResizing?: boolean | undefined;
}>();
const { t } = useTypedI18n();
const emit = defineEmits<IDeferredWorkspaceHostEmits>();


const {
    DocumentWorkspace,
    clearWorkspaceChunkRetryTimers,
    loadDocumentWorkspace,
    resetWorkspaceChunkLoadError,
    retryWorkspaceChunkRender,
    workspaceChunkLoadError,
    workspaceRenderNonce,
} = useDeferredWorkspaceChunkLoader({
    logSection: DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION,
    tabId,
});

const workspaceRequested = ref(false);
const mountedWorkspace = shallowRef<IWorkspaceExpose | null>(null);
let workspaceLoadPromise: Promise<IWorkspaceExpose | null> | null = null;
let workspacePreloadPromise: Promise<boolean> | null = null;
let isHostUnmounted = false;
const restoreAttemptState = createWorkspaceRestoreAttemptState();
const filePickerInFlightCount = ref(0);
const workspaceSplitCache = useWorkspaceSplitCache();
const fallbackDocumentSession = createWorkspaceDocumentSessionCore({
    tabId,
    initialRecord: documentRecord ?? createWorkspaceDocumentRecord(),
});
const activeDocumentSession = computed(() => documentSession ?? fallbackDocumentSession);
const {
    handleDocumentRecordUpdate,
    handleStartSectionUpdate,
    handleOpenInNewTab,
    handleRequestCloseTab,
    handleOpenSettings,
    handleOpenCombine,
    handleToggleFullscreen,
    handleWorkspaceExposeReady,
    handleWorkspaceExposeReleased,
} = createDeferredWorkspaceHostBindings({
    emit,
    hasExternalDocumentSession: Boolean(documentSession),
    activeDocumentSession,
    mountedWorkspace,
});
const splitCacheSession = computed(() => createWorkspaceSplitCacheSessionState(activeDocumentSession.value));

const {
    recentFiles,
    isResolved,
    loadRecentFiles,
    removeRecentFile,
    clearRecentFiles,
} = useRecentFiles();
const hasMountedWorkspace = computed(() => mountedWorkspace.value !== null);
const hasWorkspaceChunkLoadError = computed(() => workspaceChunkLoadError.value !== null);
const workspaceRenderKey = computed(() => `${tabId}:${workspaceRenderNonce.value}`);
const currentToolbarSnapshot = computed(() => documentRecord?.toolbarSnapshot ?? createDefaultWorkspaceToolbarSnapshot());
const activeDocumentOpenTransaction = computed(() => {
    const transaction = activeDocumentSession.value.snapshot.value.activeTransaction;
    return transaction && (
        transaction.kind === 'open'
        || transaction.kind === 'restore'
        || transaction.kind === 'reload'
    )
        ? transaction
        : null;
});
const workspaceVisibleDocument = computed(() => {
    const snapshot = currentToolbarSnapshot.value;
    return hasWorkspaceViewerDocumentCapabilities(snapshot.viewerCapabilities)
        || snapshot.isOpeningDocument || snapshot.hasOpenError || documentRecord?.documentIdentity !== null || tabHasDocumentHint(documentRecord?.tab ?? {});
});
const hasPendingDocumentHint = computed(() => hasDocumentHint === true && !workspaceVisibleDocument.value);
const pendingDocumentPath = computed(() => (
    activeDocumentOpenTransaction.value?.documentRef
    ?? (hasDocumentHint === true ? documentPath : null)
));
const isPlaceholderVisible = computed(() => (
    shouldShowWorkspacePlaceholder({
        hasQueuedSplitRestore: hasQueuedSplitRestore.value,
        hasPendingDocumentHint: hasPendingDocumentHint.value,
        hasVisibleDocument: workspaceVisibleDocument.value,
        isDocumentOpenInFlight: isDocumentOpenInFlight.value,
    })
));
const workspaceLoadErrorDescription = computed(() => {
    const message = getAsyncChunkLoadErrorMessage(workspaceChunkLoadError.value).trim();
    if (!message) {
        return t('errors.workspace.loadDescription');
    }
    return t('errors.workspace.loadDescriptionWithMessage', { message });
});
const hasPdf = computed(() => {
    const value = mountedWorkspace.value?.hasPdf;
    if (typeof value === 'boolean') {
        return value;
    }
    return value?.value ?? currentToolbarSnapshot.value.hasPdf;
});

function readWorkspaceToolbarSnapshot() {
    const baseSnapshot = mountedWorkspace.value?.getToolbarSnapshot() ?? currentToolbarSnapshot.value;
    const isOpeningDocument = isDocumentOpenInFlight.value || hasPendingDocumentHint.value;
    return {
        ...baseSnapshot,
        isOpeningDocument: baseSnapshot.isOpeningDocument || isOpeningDocument,
    };
}

function emitCurrentViewSessionState(snapshot: IWorkspaceToolbarSnapshot = readWorkspaceToolbarSnapshot()) {
    emit('update-session-state', createTabViewSessionState(snapshot));
}
const hasQueuedSplitRestore = computed(() => {
    const session = splitCacheSession.value;
    return session
        ? workspaceSplitCache.has(tabId, {session})
        : workspaceSplitCache.has(tabId);
});
const isDocumentOpenInFlight = computed(() => activeDocumentOpenTransaction.value !== null);
const isFilePickerInFlight = computed(() => filePickerInFlightCount.value > 0);
// Startup open-claim is a background probe. Mark the open UI busy only once the
// user or restore flow is actually opening a document.
const isOpenUiBusy = computed(() => isDocumentOpenInFlight.value || isFilePickerInFlight.value);
let documentOpenQueue: Promise<unknown> = Promise.resolve();
const isHostErrorVisible = computed(() => hasWorkspaceChunkLoadError.value && workspaceRequested.value && !hasMountedWorkspace.value);
const showHostDocumentOpenSkeleton = computed(() => (
    isDocumentOpenInFlight.value
    && !hasMountedWorkspace.value
    && !hasWorkspaceChunkLoadError.value
    && !isPlaceholderVisible.value
));
const isHostLoaderVisible = computed(() => (
    shouldShowWorkspaceHostLoader({
        hasHostError: isHostErrorVisible.value,
        hasQueuedSplitRestore: hasQueuedSplitRestore.value,
        hasPendingDocumentHint: hasPendingDocumentHint.value,
        hasVisibleDocument: workspaceVisibleDocument.value,
        isDocumentOpenInFlight: isDocumentOpenInFlight.value,
        isStartupOpenClaimPending,
    })
));
const loaderVariant = computed(() => {
    if (isHostErrorVisible.value) {
        return 'workspace-mount:error';
    }

    if (!isHostLoaderVisible.value) {
        return 'none';
    }

    if (isStartupOpenClaimPending) {
        return 'startup-open:claiming';
    }

    return 'none';
});

function requestWorkspaceMount(reason: string) {
    if (workspaceRequested.value) {
        return;
    }

    workspaceRequested.value = true;
    BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Requesting workspace mount', {
        tabId: tabId,
        reason,
    });
}

const workspaceHasDocumentOrOpenError = () => getWorkspaceHasDocumentOrOpenError(
    mountedWorkspace.value,
    activeDocumentSession.value.snapshot.value,
);
const workspaceHasOpenedDocument = () => getWorkspaceHasOpenedDocument(
    mountedWorkspace.value,
    activeDocumentSession.value.snapshot.value,
);
const workspaceSessionHasOpenedDocument = () => getWorkspaceSessionHasOpenedDocument(activeDocumentSession.value.snapshot.value);
function markWorkspaceRestoreAttemptFinished(
    snapshot: IWorkspaceDocumentSessionSnapshot,
    path: TDocumentRef,
    result: unknown,
) {
    finishWorkspaceRestoreAttempt(restoreAttemptState, snapshot, path, result !== false);
}

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

    BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.LOADER_LOG_SECTION, 'Workspace host loader variant changed', {
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
        resetWorkspaceChunkLoadError();
    }
});

watch(
    () => isActive || isRenderActive,
    (active, wasActive) => {
        if (wasActive && !active) {
            emitCurrentViewSessionState();
        }
    },
    { flush: 'sync' },
);

watch(
    [
        () => isActive,
        () => isRenderActive,
        () => documentPath,
        isDocumentOpenInFlight,
    ],
    ([
        active,
        renderActive,
        path,
        opening,
    ]) => {
        const snapshot = activeDocumentSession.value.snapshot.value;
        if (
            !(active || renderActive)
            || !path
            || hasDocumentHint !== true
            || workspaceHasOpenedDocument()
            || opening
            || !tryClaimWorkspaceRestoreAttempt(restoreAttemptState, snapshot, path)
        ) {
            return;
        }

        void enqueueDocumentOpen({
            action: 'restoreTabDocument',
            target: null,
        }, async () => {
            return openPath(path, 'restoreTabDocument');
        })
            .then(result => markWorkspaceRestoreAttemptFinished(snapshot, path, result))
            .catch(() => markWorkspaceRestoreAttemptFinished(snapshot, path, false));
    },
    { immediate: true },
);

watch([
    hasMountedWorkspace,
    isDocumentOpenInFlight,
], ([
    mounted,
    opening,
]) => {
    const snapshot = activeDocumentSession.value.snapshot.value;
    const restorePath = documentPath;
    if (
        !mounted
        || opening
        || !(isActive || isRenderActive)
        || !initialViewState
        || !restorePath
        || workspaceHasOpenedDocument()
        || !tryClaimWorkspaceRestoreAttempt(restoreAttemptState, snapshot, restorePath)
    ) {
        return;
    }

    void enqueueDocumentOpen({
        action: 'restoreColdDocument',
        target: buildPendingTabDocumentHint(restorePath),
    }, async () => withWorkspace(
        'restoreColdDocument',
        workspace => workspace.handleOpenFileDirectWithPersist(restorePath),
    ))
        .then(result => markWorkspaceRestoreAttemptFinished(snapshot, restorePath, result))
        .catch(() => markWorkspaceRestoreAttemptFinished(snapshot, restorePath, false));
});

function handleRetryWorkspaceMount() {
    BrowserLogger.info(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Retrying DocumentWorkspace async chunk load', {tabId: tabId});

    retryWorkspaceChunkRender();
    workspaceLoadPromise = null;
    workspaceRequested.value = true;
    void preloadWorkspaceComponent('manual-retry');
}

onErrorCaptured((error, instance, info) => {
    handleDocumentWorkspaceCrash(error, instance?.$options.name ?? null, info, {
        tabId,
        failActiveTransaction: () => {
            const transaction = activeDocumentSession.value.snapshot.value.activeTransaction;
            if (transaction) activeDocumentSession.value.finishTransaction(transaction.id, 'failed');
        },
        releaseWorkspace: handleWorkspaceExposeReleased,
        resetWorkspaceLoad: () => { workspaceLoadPromise = null; },
        setError: value => { workspaceChunkLoadError.value = value; },
    });
    return false;
});

function shouldSeedPendingTabHint(target: TTabUpdate | null | undefined) {
    return shouldSeedPendingTabHintForDocumentOpen({
        target,
        hasWorkspaceOpenedDocument: workspaceHasOpenedDocument(),
        hasWorkspaceSessionOpenedDocument: workspaceSessionHasOpenedDocument(),
    });
}

function beginDocumentOpenTransaction(intent: IDocumentOpenIntent) {
    const target = intent.target ?? null;
    const sessionTransaction = activeDocumentSession.value.beginTransaction({
        kind: resolveDocumentOpenTransactionKind(intent.action),
        documentRef: resolveTransactionDocumentRef(target, documentPath ?? null),
    });
    if (!sessionTransaction) {
        BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open transaction deferred because another transaction is active', {
            tabId: tabId,
            action: intent.action,
            activeTransaction: activeDocumentSession.value.snapshot.value.activeTransaction,
        });
        return null;
    }
    const transaction: IDocumentOpenTransactionRun = {
        sessionTransaction,
        action: intent.action,
        target,
        seededTabHint: shouldSeedPendingTabHint(target),
    };

    if (transaction.seededTabHint && target) {
        handleDocumentRecordUpdate(createPendingWorkspaceDocumentRecord(target));
    }

    requestWorkspaceMount(`document-open:${intent.action}`);

    BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open transaction started', {
        tabId: tabId,
        transactionId: sessionTransaction.id,
        action: transaction.action,
        seededTabHint: transaction.seededTabHint,
        target: transaction.target,
    });

    return transaction;
}

async function waitForDocumentOpenTerminalState(transaction: IDocumentOpenTransactionRun, opened: boolean) {
    await nextTick();

    if (!opened) {
        return false;
    }

    const deadline = Date.now() + DEFERRED_WORKSPACE_HOST_POLICY.DOCUMENT_OPEN_SETTLE_TIMEOUT_MS;
    while (
        !isHostUnmounted
        && activeDocumentOpenTransaction.value?.id === transaction.sessionTransaction.id
        && Date.now() < deadline
    ) {
        const workspace = mountedWorkspace.value;
        if (workspace) {
            const remainingMs = Math.max(0, deadline - Date.now());
            if (remainingMs > 0) {
                try {
                    await Promise.race([
                        workspace.waitForDocumentOpenSettled(),
                        delay(remainingMs).then(() => {
                            throw new Error('Document open settle timed out');
                        }),
                    ]);
                } catch (error) {
                    BrowserLogger.warn(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open settle wait failed', {
                        tabId: tabId,
                        transactionId: transaction.sessionTransaction.id,
                        action: transaction.action,
                        target: transaction.target,
                        error,
                    });
                    return false;
                }
            }

            if (workspaceHasDocumentOrOpenError()) {
                return true;
            }
        } else {
            await delay(DEFERRED_WORKSPACE_HOST_POLICY.WORKSPACE_MOUNT_POLL_INTERVAL_MS);
        }
    }

    if (!workspaceHasDocumentOrOpenError()) {
        BrowserLogger.warn(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open did not reach a terminal visible state before settle timeout', {
            tabId: tabId,
            transactionId: transaction.sessionTransaction.id,
            action: transaction.action,
            target: transaction.target,
            timeoutMs: DEFERRED_WORKSPACE_HOST_POLICY.DOCUMENT_OPEN_SETTLE_TIMEOUT_MS,
            hasMountedWorkspace: hasMountedWorkspace.value,
        });
    }

    return workspaceHasDocumentOrOpenError();
}

function finishDocumentOpenTransaction(transaction: IDocumentOpenTransactionRun, opened: boolean) {
    activeDocumentSession.value.finishTransaction(
        transaction.sessionTransaction.id,
        opened ? 'committed' : 'failed',
    );

    if (!opened && transaction.seededTabHint && !workspaceHasDocumentOrOpenError()) {
        handleDocumentRecordUpdate(createWorkspaceDocumentRecord());
    }

    BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open transaction finished', {
        tabId: tabId,
        transactionId: transaction.sessionTransaction.id,
        action: transaction.action,
        opened,
        hasTerminalDocumentState: workspaceHasDocumentOrOpenError(),
    });
}

async function runWithDocumentOpenInFlight<T>(
    intent: IDocumentOpenIntent,
    run: () => Promise<T>,
): Promise<T | false> {
    if (isHostUnmounted) {
        return false;
    }
    if (intent.commandTarget && !activeDocumentSession.value.validateCommandTarget(intent.commandTarget).ok) {
        return false;
    }
    const transaction = beginDocumentOpenTransaction(intent);
    if (!transaction) {
        return false;
    }
    let opened = false;
    try {
        const result = await run();
        const settledResult = resolveDocumentOpenRunResult(
            result,
            await waitForDocumentOpenTerminalState(transaction, result !== false),
        );
        if (settledResult === false) {
            return false;
        }
        opened = true;
        return settledResult;
    } finally {
        finishDocumentOpenTransaction(transaction, opened);
    }
}

async function enqueueDocumentOpen<T>(
    intent: IDocumentOpenIntent,
    run: () => Promise<T>,
): Promise<T | false> {
    if (isHostUnmounted) {
        return false;
    }
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
        return await platformDocuments.getDocumentPickerCapability().openDocumentDialog();
    } finally {
        filePickerInFlightCount.value = Math.max(0, filePickerInFlightCount.value - 1);
    }
}

async function preloadWorkspaceComponent(reason: string) {
    if (workspacePreloadPromise) {
        return workspacePreloadPromise;
    }

    BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Preloading DocumentWorkspace chunk', {
        tabId: tabId,
        reason,
    });

    workspacePreloadPromise = loadDocumentWorkspace()
        .then(() => {
            BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'DocumentWorkspace chunk preloaded', {
                tabId: tabId,
                reason,
            });
            return true;
        })
        .catch((error) => {
            BrowserLogger.error(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Failed to preload DocumentWorkspace chunk', {
                tabId: tabId,
                reason,
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        })
        .finally(() => {
            workspacePreloadPromise = null;
        });

    return workspacePreloadPromise;
}

async function waitForWorkspaceMount(
    timeoutMs: number = DEFERRED_WORKSPACE_HOST_POLICY.WORKSPACE_MOUNT_TIMEOUT_MS,
) {
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

        await delay(DEFERRED_WORKSPACE_HOST_POLICY.WORKSPACE_MOUNT_POLL_INTERVAL_MS);
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

    requestWorkspaceMount(`ensureWorkspaceLoaded:${reason}`);

    const preloadSucceeded = await preloadWorkspaceComponent(`ensureWorkspaceLoaded:${reason}`);
    if (!preloadSucceeded) {
        BrowserLogger.warn(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Proceeding with workspace mount after preload failure', {
            tabId: tabId,
            reason,
        });
    }

    workspaceLoadPromise ??= waitForWorkspaceMount().finally(() => {
        workspaceLoadPromise = null;
    });

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
        BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Workspace mount ready', {
            tabId: tabId,
            reason,
        });
    }
    return loadedWorkspace;
}

async function withLoadedWorkspace<T = void>(action: string, run: (workspace: IWorkspaceExpose) => Promise<T> | T) {
    let workspace = mountedWorkspace.value ?? await ensureWorkspaceLoaded(action);
    if (!workspace && !hasWorkspaceChunkLoadError.value) {
        workspace = await waitForWorkspaceMount(DEFERRED_WORKSPACE_HOST_POLICY.WORKSPACE_MOUNT_RETRY_TIMEOUT_MS);
    }
    if (!workspace) {
        BrowserLogger.error('workspace-host', 'Workspace unavailable for loaded action', {
            tabId: tabId,
            action,
            hasWorkspaceChunkLoadError: hasWorkspaceChunkLoadError.value,
            error: workspaceChunkLoadError.value,
        });
        return undefined;
    }

    try {
        return await run(workspace);
    } catch (error) {
        BrowserLogger.error('workspace-host', `Action failed (${action})`, {
            tabId: tabId,
            error,
        });
        return undefined;
    }
}

async function withLoadedWorkspaceRequired<T = void>(
    action: string,
    run: (workspace: IWorkspaceExpose) => Promise<T> | T,
) {
    let workspace = mountedWorkspace.value ?? await ensureWorkspaceLoaded(action);
    if (!workspace && !hasWorkspaceChunkLoadError.value) {
        workspace = await waitForWorkspaceMount(DEFERRED_WORKSPACE_HOST_POLICY.WORKSPACE_MOUNT_RETRY_TIMEOUT_MS);
    }
    if (!workspace) {
        const error = new Error('Workspace is not available.');
        BrowserLogger.error('workspace-host', 'Workspace unavailable for loaded action', {
            tabId: tabId,
            action,
            hasWorkspaceChunkLoadError: hasWorkspaceChunkLoadError.value,
            error: workspaceChunkLoadError.value,
        });
        throw error;
    }

    try {
        return await run(workspace);
    } catch (error) {
        BrowserLogger.error('workspace-host', `Action failed (${action})`, {
            tabId: tabId,
            error,
        });
        throw error;
    }
}

async function withWorkspace(
    action: string,
    run: (workspace: IWorkspaceExpose) => Promise<boolean | undefined> | boolean | undefined,
) {
    BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'withWorkspace start', {
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
        workspace = await waitForWorkspaceMount(DEFERRED_WORKSPACE_HOST_POLICY.WORKSPACE_MOUNT_RETRY_TIMEOUT_MS);
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
        BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'withWorkspace completed', {
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
    BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Attempting open path', {
        tabId: tabId,
        action,
        path,
    });
    return withWorkspace(action, workspace => workspace.handleOpenFileDirectWithPersist(path));
}

async function handleOpenRecentFromPlaceholder(file: IRecentFile) {
    BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Recent item clicked from placeholder', {
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
            BrowserLogger.error(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Failed to preload workspace for recent open', {
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
        await platformDocuments.getDocumentWindowCapability().showItemInFolder(file.originalPath);
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
    if (!result || isHostUnmounted) {
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
    emit('expose-ready', workspaceExpose);
    if (shouldPreloadWorkspaceOnHostMount({
        hasQueuedSplitRestore: hasQueuedSplitRestore.value,
        hasDocumentHint: hasDocumentHint === true,
        isActive: isActive || isRenderActive,
        isDev: import.meta.dev,
    })) {
        void preloadWorkspaceComponent('workspace-host-mounted');
    }

    BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Workspace host mounted; loading recent files', {tabId: tabId});
    void loadRecentFiles().finally(() => {
        BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Workspace host recent files load settled', {
            tabId: tabId,
            count: recentFiles.value.length,
        });
    });
});

onUnmounted(() => {
    isHostUnmounted = true;
    emit('expose-released');
    workspaceLoadPromise = null;
    workspacePreloadPromise = null;
    clearWorkspaceChunkRetryTimers();
});

const workspaceExpose: IWorkspaceExpose = createDeferredWorkspaceExposeProxy({
    documentSession: activeDocumentSession.value,
    enqueueDocumentOpen,
    getMounted: () => mountedWorkspace.value,
    log: (action, error) => {
        BrowserLogger.error('workspace-host', `Action failed (${action})`, {
            tabId: tabId,
            error,
        });
    },
    openPath,
    overrides: {
        getToolbarSnapshot: () => readWorkspaceToolbarSnapshot(),
        handleOpenFileFromUi,
        hasPdf,
    },
    withLoadedWorkspace,
    withLoadedWorkspaceRequired,
    withWorkspace,
});

defineExpose(workspaceExpose);
</script>

<style src="./DeferredDocumentWorkspaceHost.css" scoped></style>
