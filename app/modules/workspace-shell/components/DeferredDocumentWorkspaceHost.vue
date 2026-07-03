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

        <WorkspaceHostDocumentOpenFallback
            v-if="showHostDocumentOpenSkeleton"
            :path="pendingDocumentPath"
        />

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
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import { resolveWorkspaceRequestedState } from '@app/modules/workspace-shell/host/resolveWorkspaceRequestedState';
import { shouldPreloadWorkspaceOnHostMount } from '@app/modules/workspace-shell/host/shouldPreloadWorkspaceOnHostMount';
import { shouldShowWorkspaceHostLoader } from '@app/modules/workspace-shell/host/shouldShowWorkspaceHostLoader';
import { shouldShowWorkspacePlaceholder } from '@app/modules/workspace-shell/host/shouldShowWorkspacePlaceholder';
import {
    workspaceHasDocumentOrOpenError as getWorkspaceHasDocumentOrOpenError,
    workspaceHasOpenedDocument as getWorkspaceHasOpenedDocument,
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
    IWorkspaceDocumentTransaction,
    TWorkspaceDocumentTransactionKind,
} from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';
import { useDeferredWorkspaceChunkLoader } from '@app/modules/workspace-shell/composables/useDeferredWorkspaceChunkLoader';

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
}>();
const { t } = useTypedI18n();

const emit = defineEmits<{
    'update-document-record': [record: IWorkspaceDocumentRecord];
    'update-session-state': [state: ITabViewSessionState];
    'update:start-section': [section: TStartSection];
    'open-in-new-tab': [result: string | TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
    'expose-ready': [expose: IWorkspaceExpose];
    'expose-released': [];
}>();

function handleDocumentRecordUpdate(record: IWorkspaceDocumentRecord) {
    activeDocumentSession.value.applyWorkspaceRecord(record, 'workspace');
    emit('update-document-record', record);
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

function handleWorkspaceExposeReady(expose: IWorkspaceExpose) {
    mountedWorkspace.value = expose;
    activeDocumentSession.value.attachWorkspace(expose);
}

function handleWorkspaceExposeReleased() {
    mountedWorkspace.value = null;
    activeDocumentSession.value.detachWorkspace();
}
const RECENT_OPEN_LOG_SECTION = 'recent-open';
const LOADER_LOG_SECTION = 'loader';
const DOCUMENT_OPEN_SETTLE_TIMEOUT_MS = 4_000;

interface IDocumentOpenTransactionRun {
    sessionTransaction: IWorkspaceDocumentTransaction;
    action: string;
    target: TTabUpdate | null;
    seededTabHint: boolean;
}

interface IDocumentOpenIntent {
    action: string;
    commandTarget?: TWorkspaceCommandTarget | undefined;
    target?: TTabUpdate | null;
}

const WORKSPACE_MOUNT_POLL_INTERVAL_MS = 25;

const {
    DocumentWorkspace,
    clearWorkspaceChunkRetryTimers,
    loadDocumentWorkspace,
    resetWorkspaceChunkLoadError,
    retryWorkspaceChunkRender,
    workspaceChunkLoadError,
    workspaceRenderNonce,
} = useDeferredWorkspaceChunkLoader({
    logSection: RECENT_OPEN_LOG_SECTION,
    tabId,
});

const workspaceRequested = ref(false);
const mountedWorkspace = shallowRef<IWorkspaceExpose | null>(null);
let workspaceLoadPromise: Promise<IWorkspaceExpose | null> | null = null;
let workspacePreloadPromise: Promise<boolean> | null = null;
let isHostUnmounted = false;
const filePickerInFlightCount = ref(0);
const workspaceSplitCache = useWorkspaceSplitCache();
const WORKSPACE_MOUNT_TIMEOUT_MS = 30_000;
const WORKSPACE_MOUNT_RETRY_TIMEOUT_MS = 20_000;
const fallbackDocumentSession = createWorkspaceDocumentSessionCore({
    tabId,
    initialRecord: documentRecord ?? createWorkspaceDocumentRecord(),
});
const activeDocumentSession = computed(() => documentSession ?? fallbackDocumentSession);
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
const workspaceHasDocumentOrOpenError = () => getWorkspaceHasDocumentOrOpenError(mountedWorkspace.value);
const workspaceHasOpenedDocument = () => getWorkspaceHasOpenedDocument(mountedWorkspace.value);
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
    return hasWorkspaceViewerDocumentCapabilities(snapshot.viewerCapabilities) || snapshot.isOpeningDocument || snapshot.hasOpenError;
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
    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Requesting workspace mount', {
        tabId: tabId,
        reason,
    });
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
        if (
            !(active || renderActive)
            || !path
            || hasDocumentHint !== true
            || workspaceHasOpenedDocument()
            || opening
        ) {
            return;
        }

        void enqueueDocumentOpen({
            action: 'restoreTabDocument',
            target: null,
        }, async () => {
            return openPath(path, 'restoreTabDocument');
        });
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

    retryWorkspaceChunkRender();
    workspaceLoadPromise = null;
    workspaceRequested.value = true;
    void preloadWorkspaceComponent('manual-retry');
}

function shouldSeedPendingTabHint(target: TTabUpdate | null | undefined) {
    return Boolean(
        target
        && !workspaceHasOpenedDocument(),
    );
}

function resolveDocumentOpenTransactionKind(action: string): TWorkspaceDocumentTransactionKind {
    return action.toLowerCase().includes('restore') ? 'restore' : 'open';
}

function resolveTransactionDocumentRef(target: TTabUpdate | null) {
    return target?.originalPath ?? documentPath ?? null;
}

function beginDocumentOpenTransaction(intent: IDocumentOpenIntent) {
    const target = intent.target ?? null;
    const sessionTransaction = activeDocumentSession.value.beginTransaction({
        kind: resolveDocumentOpenTransactionKind(intent.action),
        documentRef: resolveTransactionDocumentRef(target),
    });
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

    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Document open transaction started', {
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
        return;
    }

    const deadline = Date.now() + DOCUMENT_OPEN_SETTLE_TIMEOUT_MS;
    while (
        !isHostUnmounted
        && activeDocumentOpenTransaction.value?.id === transaction.sessionTransaction.id
        && Date.now() < deadline
    ) {
        const workspace = mountedWorkspace.value;
        if (workspace) {
            const remainingMs = Math.max(0, deadline - Date.now());
            if (remainingMs > 0) {
                await Promise.race([
                    workspace.waitForDocumentOpenSettled(),
                    delay(remainingMs),
                ]);
            }

            if (workspaceHasDocumentOrOpenError()) {
                return;
            }
        } else {
            await delay(WORKSPACE_MOUNT_POLL_INTERVAL_MS);
        }
    }

    if (!workspaceHasDocumentOrOpenError()) {
        BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Document open did not reach a terminal visible state before settle timeout', {
            tabId: tabId,
            transactionId: transaction.sessionTransaction.id,
            action: transaction.action,
            target: transaction.target,
            timeoutMs: DOCUMENT_OPEN_SETTLE_TIMEOUT_MS,
            hasMountedWorkspace: hasMountedWorkspace.value,
        });
    }
}

function finishDocumentOpenTransaction(transaction: IDocumentOpenTransactionRun, opened: boolean) {
    activeDocumentSession.value.finishTransaction(
        transaction.sessionTransaction.id,
        opened ? 'committed' : 'failed',
    );

    if (!opened && transaction.seededTabHint && !workspaceHasDocumentOrOpenError()) {
        handleDocumentRecordUpdate(createWorkspaceDocumentRecord());
    }

    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Document open transaction finished', {
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
        }
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
                error: error instanceof Error ? error.message : String(error),
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

        await delay(WORKSPACE_MOUNT_POLL_INTERVAL_MS);
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
        BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Proceeding with workspace mount after preload failure', {
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
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Workspace mount ready', {
            tabId: tabId,
            reason,
        });
    }
    return loadedWorkspace;
}

async function withLoadedWorkspace<T = void>(action: string, run: (workspace: IWorkspaceExpose) => Promise<T> | T) {
    let workspace = mountedWorkspace.value ?? await ensureWorkspaceLoaded(action);
    if (!workspace && !hasWorkspaceChunkLoadError.value) {
        workspace = await waitForWorkspaceMount(WORKSPACE_MOUNT_RETRY_TIMEOUT_MS);
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
        workspace = await waitForWorkspaceMount(WORKSPACE_MOUNT_RETRY_TIMEOUT_MS);
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

    BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Workspace host mounted; loading recent files', {tabId: tabId});
    void loadRecentFiles().finally(() => {
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Workspace host recent files load settled', {
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

<style scoped>
.workspace-host {
    position: relative;
    display: flex;
    isolation: isolate;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
}

.workspace-host__placeholder {
    position: relative;
    z-index: 0;
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
}

.workspace-host__workspace {
    position: relative;
    z-index: 0;
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
}

.workspace-host__loading {
    position: absolute;
    inset: 0;
    z-index: 30;
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
