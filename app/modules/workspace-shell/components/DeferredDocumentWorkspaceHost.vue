<template>
    <div
        ref="workspaceHostElement"
        class="workspace-host"
        :data-workspace-active="isActive ? 'true' : 'false'"
        :data-workspace-render-active="isRenderActive ? 'true' : 'false'"
        :data-workspace-tab-id="tabId"
        :data-recent-open-owner-ready="isRecentOpenOwnerReady ? 'true' : 'false'"
    >
        <div
            v-if="workspaceRequested && DocumentWorkspace && !hasWorkspaceChunkLoadError"
            class="workspace-host__workspace"
        >
            <component
                :is="DocumentWorkspace"
                :key="workspaceRenderKey"
                :tab-id="tabId"
                :is-active="isActive && !isPlaceholderVisible"
                :is-render-active="isRenderActive"
                :is-tab-transition-busy="isTabTransitionBusy"
                :initial-view-state="initialViewState"
                :pending-document-open="isDocumentOpenInFlight"
                :pending-document-path="pendingDocumentPath"
                suppress-empty-state
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
                @viewer-owner-ready="handleViewerOwnerReady"
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
                :recent-open-disabled="!isRecentOpenOwnerReady"
                :is-recent-open-ready="isRecentFileOpenReady"
                :is-recent-open-exact-frame-ready="isRecentFileExactFrameReady"
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

        <DocumentWorkspaceFailurePanel
            v-if="isHostErrorVisible"
            :description="workspaceLoadErrorDescription"
            @close="handleRequestCloseTab"
            @retry="handleRetryWorkspaceMount"
        />
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
import { PdfEmptyState } from '@app/modules/pdf-viewer/public/component-exports/pdfEmptyState';
import DocumentWorkspaceFailurePanel from '@app/modules/workspace-shell/components/DocumentWorkspaceFailurePanel.vue';
import { handleDocumentWorkspaceCrash } from '@app/modules/workspace-shell/checkpoint/handleDocumentWorkspaceCrash';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import { resolveWorkspaceRequestedState } from '@app/modules/workspace-shell/host/resolveWorkspaceRequestedState';
import { createImmediateSerializedQueue } from '@app/modules/workspace-shell/host/createImmediateSerializedQueue';
import { createDeferredWorkspaceLoadGateway } from '@app/modules/workspace-shell/host/createDeferredWorkspaceLoadGateway';
import { shouldPreloadWorkspaceOnHostMount } from '@app/modules/workspace-shell/host/shouldPreloadWorkspaceOnHostMount';
import {
    beginRecentOpenGeometryPrewarm,
    isRecentOpenGeometryExactFrameReady,
    readRecentOpenExactGeometry,
    readRecentOpenGeometryState,
    settleRecentOpenGeometryPrewarm,
} from '@app/modules/workspace-shell/host/recentOpenGeometryReadiness';
import { getDjvuCapability } from '@app/utils/getDjvuCapability';
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
    canBeginDocumentOpenSynchronously,
    resolveDocumentOpenRunResult,
    resolveOpenSurfaceDocumentId,
    resolvePreparedPdfOpeningGeometry,
    resolveDocumentOpenTransactionKind,
    resolveTransactionDocumentRef,
    shouldWaitForPreparedOpeningOwner,
    shouldSeedPendingTabHint as shouldSeedPendingTabHintForDocumentOpen,
} from '@app/modules/workspace-shell/host/deferredWorkspaceHostDocumentOpen';
import {
    createDocumentOpenSurfaceSession,
    documentOpenSurfaceSessionKey,
    shouldPresentDocumentOpenEmptyPlaceholder,
} from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { IDocumentOpeningPageFrameAuthority } from '@app/utils/document-viewer/chassis/documentOpeningPageFrameAuthority';
import { shouldResetDocumentOpenSurfaceForEmptySession } from '@app/modules/workspace-shell/host/shouldResetDocumentOpenSurfaceForEmptySession';
import { isRecentOpenCommandEligible } from '@app/modules/workspace-shell/host/isRecentOpenCommandEligible';

const {
    hasDocumentHint = false,
    documentPath = null,
    documentRecord = null,
    documentSession = null,
    isActive,
    isFullscreen,
    isRenderActive = isActive,
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
    isStartupOpenClaimPending: boolean;
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
const documentOpenSurface = createDocumentOpenSurfaceSession();
provide(documentOpenSurfaceSessionKey, documentOpenSurface);


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
// The active empty tab must mount the canonical workspace owner before Recent
// becomes actionable. Deferring this by animation frames leaves the placeholder
// owning clicks that cannot present an exact page shell synchronously.
const canPremountActiveEmpty = ref(true);
const mountedWorkspace = shallowRef<IWorkspaceExpose | null>(null);
const workspaceHostElement = shallowRef<HTMLElement | null>(null);
const openingPageFrameAuthority = shallowRef<IDocumentOpeningPageFrameAuthority | null>(null);
const isRecentOpenOwnerReady = ref(false);
const isViewerOwnerMounted = ref(false);
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
    handleWorkspaceExposeReleased: releaseWorkspaceExposeBinding,
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

function refreshOpeningFrameOwnerReadiness() {
    isRecentOpenOwnerReady.value = isViewerOwnerMounted.value
        && openingPageFrameAuthority.value !== null;
}

function handleViewerOwnerReady(authority: IDocumentOpeningPageFrameAuthority) {
    // The premounted chassis owns both the prepared shell and final fit scale.
    // Sharing its authority prevents the empty host from independently
    // guessing scrollbar, sidebar, or renderer viewport geometry.
    openingPageFrameAuthority.value = authority;
    isViewerOwnerMounted.value = true;
    refreshOpeningFrameOwnerReadiness();
}

function handleWorkspaceExposeReleased() {
    isViewerOwnerMounted.value = false;
    openingPageFrameAuthority.value = null;
    refreshOpeningFrameOwnerReadiness();
    releaseWorkspaceExposeBinding();
}

function isRecentFileOpenReady(file: IRecentFile) {
    return isRecentOpenCommandEligible({
        activeOpenDocumentRef: activeDocumentOpenTransaction.value?.documentRef ?? null,
        documentRef: file.originalPath,
        ownerReady: isRecentOpenOwnerReady.value,
    });
}
function isRecentFileExactFrameReady(file: IRecentFile) {
    if (!isRecentOpenGeometryExactFrameReady(file.originalPath)) {
        return false;
    }
    const geometry = readRecentOpenExactGeometry(file.originalPath, {
        modifiedAt: file.modifiedAt,
        size: file.fileSize,
    });
    const preparedFrame = geometry
        ? openingPageFrameAuthority.value?.draftOpeningPageFrame(geometry) ?? null
        : null;
    return preparedFrame !== null
        && preparedFrame.sourceRevisionKey !== null;
}

async function prepareRecentGeometry(documentRef: string) {
    beginRecentOpenGeometryPrewarm([documentRef]);
    try {
        if (/\.pdf$/iu.test(documentRef)) {
            const { prevalidateTrustedPdfOpenGeometry } = await import(
                '@app/modules/pdf-viewer/public/openGeometry'
            );
            const documentFiles = getDocumentFilesCapability();
            const geometry = await prevalidateTrustedPdfOpenGeometry(
                documentRef,
                1,
                undefined,
                documentFiles.getPdfOpeningGeometry
                    ? () => documentFiles.getPdfOpeningGeometry!(documentRef)
                    : undefined,
                {forceAuthoritativeRefresh: true},
            );
            settleRecentOpenGeometryPrewarm(documentRef, geometry ? 'ready' : 'cold-fallback');
        } else if (/\.djvu?$/iu.test(documentRef)) {
            const { prewarmRecentDjvuOpeningGeometry } = await import(
                '@app/modules/djvu-viewer/public/openGeometry'
            );
            const file = recentFiles.value.find(candidate => candidate.originalPath === documentRef);
            if (!file) {
                settleRecentOpenGeometryPrewarm(documentRef, 'cold-fallback');
                return;
            }
            const result = await prewarmRecentDjvuOpeningGeometry(
                [file],
                {readSourceInfo: path => getDjvuCapability().getPageSourceInfo(path, 1)},
                {limit: 1},
            );
            settleRecentOpenGeometryPrewarm(
                documentRef,
                result.get(documentRef) ? 'ready' : 'cold-fallback',
            );
        }
    } catch (error) {
        settleRecentOpenGeometryPrewarm(documentRef, 'cold-fallback');
        BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Closed document exact Recent geometry refresh failed', {
            documentRef,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

watch(
    recentFiles,
    (files) => {
        for (const file of files) {
            if (readRecentOpenGeometryState(file.originalPath) === 'cold-fallback') {
                void prepareRecentGeometry(file.originalPath);
            }
        }
    },
    {
        flush: 'post',
        immediate: true,
    },
);

watch(
    () => activeDocumentSession.value.snapshot.value,
    (session) => {
        if (!shouldResetDocumentOpenSurfaceForEmptySession(session, documentOpenSurface.snapshot.value)) {
            return;
        }
        // Closing a document ends its visual generation. Re-arm Recent from
        // the current empty session and the current chassis/layout authority;
        // never inherit the closed document's prepared-frame ownership.
        documentOpenSurface.reset();
    },
    {flush: 'sync'},
);
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
    ?? (hasPendingDocumentHint.value ? documentPath : null)
));
const isPlaceholderVisible = computed(() => {
    return shouldPresentDocumentOpenEmptyPlaceholder(documentOpenSurface.snapshot.value);
});
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
const enqueueSerializedDocumentOpen = createImmediateSerializedQueue();
const isHostErrorVisible = computed(() => hasWorkspaceChunkLoadError.value && workspaceRequested.value && !hasMountedWorkspace.value);
const loaderVariant = computed(() => {
    if (isHostErrorVisible.value) {
        return 'workspace-mount:error';
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

const workspaceLoadGateway = createDeferredWorkspaceLoadGateway({
    tabId,
    mountedWorkspace,
    workspaceChunkLoadError,
    loadDocumentWorkspace,
    requestWorkspaceMount,
    isHostUnmounted: () => isHostUnmounted,
});
const {
    ensureWorkspaceLoaded,
    preloadWorkspaceComponent,
    withLoadedWorkspace,
    withLoadedWorkspaceRequired,
    withWorkspace,
} = workspaceLoadGateway;

const workspaceHasDocumentOrOpenError = () => getWorkspaceHasDocumentOrOpenError(
    mountedWorkspace.value,
    activeDocumentSession.value.snapshot.value,
);
const workspaceHasOpenedDocument = () => getWorkspaceHasOpenedDocument(
    mountedWorkspace.value,
    activeDocumentSession.value.snapshot.value,
);
const workspaceHasSuccessfulInitialVisual = () => {
    const workspace = mountedWorkspace.value;
    if (!workspace) {
        return false;
    }
    const snapshot = workspace.getToolbarSnapshot();
    return snapshot.initialVisualReady
        && !snapshot.hasOpenError
        && hasWorkspaceViewerDocumentCapabilities(snapshot.viewerCapabilities);
};
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
        canPremountActiveEmpty,
    ],
    ([
        hasQueued,
        hasDocumentHint,
        isActive,
        isRenderActive,
        canPremount,
    ]) => {
        workspaceRequested.value = resolveWorkspaceRequestedState(workspaceRequested.value, {
            hasQueuedSplitRestore: hasQueued,
            hasDocumentHint,
            isActive: isActive || isRenderActive,
            canPremountActiveEmpty: canPremount,
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
        surface: 'document-page-skeleton',
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
    workspaceLoadGateway.resetWorkspaceLoad();
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
        resetWorkspaceLoad: workspaceLoadGateway.resetWorkspaceLoad,
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
    const currentSurface = documentOpenSurface.snapshot.value;
    const canUsePreparedRecentFrame = intent.action === 'openRecentFromPlaceholder'
        && (
            currentSurface.phase === 'idle'
            || currentSurface.phase === 'ready'
            || currentSurface.phase === 'failed'
        );
    const cachedRecentGeometry = canUsePreparedRecentFrame && target?.originalPath
        ? readRecentOpenExactGeometry(target.originalPath, {
            modifiedAt: intent.preparedSourceModifiedAt,
            size: intent.preparedSourceSize,
        })
        : null;
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

    if (
        currentSurface.phase === 'idle'
        || currentSurface.phase === 'ready'
        || currentSurface.phase === 'failed'
    ) {
        const documentId = resolveOpenSurfaceDocumentId(
            target,
            sessionTransaction.documentRef,
            tabId,
        );
        const identity = {
            documentId,
            documentRevision: `open-intent:${sessionTransaction.id}`,
        };
        const preparedOpeningGeometry = resolvePreparedPdfOpeningGeometry(
            documentId,
            intent.preparedOpeningGeometry,
        ) ?? cachedRecentGeometry;
        const preparedOpeningFrame = preparedOpeningGeometry
            ? openingPageFrameAuthority.value?.draftOpeningPageFrame(preparedOpeningGeometry) ?? null
            : null;
        const generation = preparedOpeningFrame
            ? documentOpenSurface.beginPrepared(identity, preparedOpeningFrame)
            : documentOpenSurface.begin(
                identity,
                preparedOpeningGeometry ?? readRecentOpenExactGeometry(documentId),
            );
        if (generation === null) {
            activeDocumentSession.value.finishTransaction(sessionTransaction.id, 'failed');
            BrowserLogger.warn(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open transaction rejected because the prepared page frame could not be committed atomically', {
                tabId,
                action: intent.action,
                target,
            });
            return null;
        }
        if (!preparedOpeningFrame) {
            openingPageFrameAuthority.value?.prepareOpeningPageFrame(generation);
        }
    }

    if (transaction.seededTabHint && target) {
        handleDocumentRecordUpdate(createPendingWorkspaceDocumentRecord(
            target,
            currentToolbarSnapshot.value,
        ));
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

            if (workspace.getToolbarSnapshot().hasOpenError) {
                return false;
            }
            if (workspaceHasSuccessfulInitialVisual()) {
                return true;
            }
        } else {
            await delay(DEFERRED_WORKSPACE_HOST_POLICY.WORKSPACE_MOUNT_POLL_INTERVAL_MS);
        }
    }

    if (!workspaceHasSuccessfulInitialVisual()) {
        BrowserLogger.warn(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open did not reach a terminal visible state before settle timeout', {
            tabId: tabId,
            transactionId: transaction.sessionTransaction.id,
            action: transaction.action,
            target: transaction.target,
            timeoutMs: DEFERRED_WORKSPACE_HOST_POLICY.DOCUMENT_OPEN_SETTLE_TIMEOUT_MS,
            hasMountedWorkspace: hasMountedWorkspace.value,
        });
    }

    return workspaceHasSuccessfulInitialVisual();
}

function finishDocumentOpenTransaction(transaction: IDocumentOpenTransactionRun, opened: boolean) {
    activeDocumentSession.value.finishTransaction(
        transaction.sessionTransaction.id,
        opened ? 'committed' : 'failed',
    );

    if (!opened && transaction.seededTabHint && !workspaceHasDocumentOrOpenError()) {
        handleDocumentRecordUpdate(createWorkspaceDocumentRecord());
    }
    if (
        !opened
        && documentOpenSurface.snapshot.value.identity?.documentRevision.startsWith('open-intent:')
    ) {
        documentOpenSurface.reset();
    }

    BrowserLogger.debug(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Document open transaction finished', {
        tabId: tabId,
        transactionId: transaction.sessionTransaction.id,
        action: transaction.action,
        opened,
        hasTerminalDocumentState: workspaceHasDocumentOrOpenError(),
    });
}

function hasPreparedOpeningGeometry(intent: IDocumentOpenIntent) {
    return intent.preparedOpeningGeometry !== undefined
        || Boolean(intent.target?.originalPath && readRecentOpenExactGeometry(intent.target.originalPath));
}

async function ensurePreparedOpeningOwnerReady(
    intent: IDocumentOpenIntent,
    preparedOpeningGeometryAvailable: boolean,
) {
    if (!shouldWaitForPreparedOpeningOwner(
        preparedOpeningGeometryAvailable,
        isViewerOwnerMounted.value,
    )) {
        return true;
    }

    requestWorkspaceMount(`prepared-opening-owner:${intent.action}`);
    const workspace = await ensureWorkspaceLoaded(`prepared-opening-owner:${intent.action}`);
    if (!workspace) {
        return false;
    }

    const deadline = Date.now() + DEFERRED_WORKSPACE_HOST_POLICY.WORKSPACE_MOUNT_TIMEOUT_MS;
    while (!isHostUnmounted && Date.now() < deadline) {
        if (isViewerOwnerMounted.value) {
            return true;
        }
        await delay(DEFERRED_WORKSPACE_HOST_POLICY.WORKSPACE_MOUNT_POLL_INTERVAL_MS);
    }

    BrowserLogger.error(DEFERRED_WORKSPACE_HOST_POLICY.RECENT_OPEN_LOG_SECTION, 'Prepared document open timed out before the canonical viewer owner mounted', {
        tabId,
        action: intent.action,
    });
    return false;
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
    // Keep the already-mounted path in the click call stack. Awaiting an async
    // function which immediately returns still yields one microtask; during
    // that gap the Recent empty state remains the visual owner and rapid page
    // commands can overtake the open transaction.
    const preparedOpeningGeometryAvailable = hasPreparedOpeningGeometry(intent);
    if (
        !canBeginDocumentOpenSynchronously(
            intent.action,
            preparedOpeningGeometryAvailable,
            isViewerOwnerMounted.value,
        )
        && !await ensurePreparedOpeningOwnerReady(
            intent,
            preparedOpeningGeometryAvailable,
        )
    ) {
        return false;
    }
    const transaction = beginDocumentOpenTransaction(intent);
    if (!transaction) {
        return false;
    }
    let opened = false;
    try {
        // `beginPrepared()` transfers ownership synchronously. Flush that
        // state into the already-mounted chassis before source loading starts;
        // readiness itself remains driven exclusively by joined render and
        // viewport commits.
        if (
            documentOpenSurface.snapshot.value.presentation === 'page-shell'
        ) {
            await nextTick();
            if (activeDocumentOpenTransaction.value?.id !== transaction.sessionTransaction.id) {
                return false;
            }
        }
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
    // An idle queue must publish the opening surface in the click call stack.
    // Routing even the first command through Promise.then leaves Recent visible
    // for a full async preparation interval before the canonical page owner can
    // claim its already-prepared frame.
    return enqueueSerializedDocumentOpen(() => runWithDocumentOpenInFlight(intent, run));
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
        preparedSourceModifiedAt: file.modifiedAt,
        preparedSourceSize: file.fileSize,
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
        preparedOpeningGeometry: result.kind === 'pdf' ? result.openingGeometry : undefined,
        target: buildPendingTabDocumentHint(result),
    }, async () => withWorkspace(
        'handleOpenFileWithResultFromUi',
        workspace => workspace.handleOpenFileWithResult(result),
    ));
}

onMounted(() => {
    isHostUnmounted = false;
    refreshOpeningFrameOwnerReadiness();
    emit('expose-ready', workspaceExpose);
    if (shouldPreloadWorkspaceOnHostMount({
        hasQueuedSplitRestore: hasQueuedSplitRestore.value,
        hasDocumentHint: hasDocumentHint === true,
        isActive: isActive || isRenderActive,
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

onBeforeUnmount(() => {
    // A cold-tab lifecycle update can remove this host in the same parent
    // render that changes its active props, so the deactivation watcher is not
    // guaranteed to observe an inactive frame. Capture while the mounted
    // workspace and its renderer-neutral toolbar projection are still live.
    emitCurrentViewSessionState();
});

onUnmounted(() => {
    isHostUnmounted = true;
    openingPageFrameAuthority.value = null;
    isRecentOpenOwnerReady.value = false;
    documentOpenSurface.reset();
    emit('expose-released');
    workspaceLoadGateway.dispose();
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
        // The shell toolbar is visible before the deferred workspace mounts.
        // Navigation must enter the already-owned viewport session directly;
        // a mount-wait command target can legitimately become stale as the
        // in-flight open refines its document identity.
        handleGoToPage: page => {
            documentOpenSurface.requestNavigation(page);
        },
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
