<template>
    <div
        class="app-shell-root h-screen min-w-0 flex flex-col bg-[var(--app-window-bg)]"
        :class="{ 'is-zen-mode': isFullscreen }"
    >
        <div v-if="showBrowserInstallHint" class="browser-install-hint">
            <UIcon name="i-ph-download-simple" class="browser-install-icon" />
            <a
                :href="browserInstallUrl"
                target="_blank"
                rel="noreferrer"
                class="browser-install-link"
                @click="handleBrowserInstallHintClick"
            >
                {{ t('webApp.installDesktop') }}
                <UIcon name="i-ph-arrow-up-right" class="browser-install-link-icon" />
            </a>
            <span class="browser-install-divider" />
            <button
                type="button"
                class="browser-install-dismiss"
                :aria-label="t('webApp.dismissInstallDesktop')"
                @click="dismissBrowserInstallHint('manual')"
            >
                <UIcon name="i-ph-x" class="browser-install-dismiss-icon" />
            </button>
        </div>

        <div v-show="!activeToolPage" class="editor-global-toolbar-shell">
            <ShellWorkspaceToolbar
                v-show="showShellToolbar"
                :snapshot="shellToolbarSnapshot"
                :has-pdf="shellToolbarHasPdf"
                :ocr-popup-open="shellToolbarOcrPopupOpen"
                :zoom-dropdown-open="shellToolbarZoomDropdownOpen"
                :page-dropdown-open="shellToolbarPageDropdownOpen"
                :overflow-menu-open="shellToolbarOverflowMenuOpen"
                :app-menu-open="shellToolbarAppMenuOpen"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                v-on="fallbackToolbarCommandListeners"
                @update:ocr-popup-open="shellToolbarOcrPopupOpen = $event"
                @update:zoom-dropdown-open="shellToolbarZoomDropdownOpen = $event"
                @update:page-dropdown-open="shellToolbarPageDropdownOpen = $event"
                @update:overflow-menu-open="shellToolbarOverflowMenuOpen = $event"
                @update:app-menu-open="shellToolbarAppMenuOpen = $event"
                @update:zoom="shellToolbarZoom = $event"
                @update:effective-zoom="shellToolbarEffectiveZoom = $event"
                @update:zoom-mode="shellToolbarZoomMode = $event"
                @update:fit-mode="shellToolbarFitMode = $event"
                @update:view-mode="shellToolbarViewMode = $event"
                @update:current-page="shellToolbarCurrentPage = $event"
                @open-file="handleFallbackToolbarOpenFile"
                @open-settings="openSettingsPage"
                @combine-images="openCombinePage"
                @toggle-fullscreen="handleToggleFullscreen"
                @set-view-mode="handleShellToolbarOverflowSetViewMode"
            />
            <div
                v-show="!showShellToolbar"
                id="editor-global-toolbar-host"
                ref="globalToolbarHostRef"
                class="editor-global-toolbar-host"
            />
        </div>

        <div v-show="!activeToolPage" class="workspace-main-shell">
            <EditorPanesHost
                :layout="layout"
                :panes="panes"
                :tabs="tabs"
                :active-pane-id="activePaneId"
                :is-startup-open-claim-pending="isStartupOpenClaimPending"
                :is-tab-transition-busy="isTabTransitionBusy"
                :tab-context-availability-by-pane="tabContextAvailabilityByPane"
                :start-section-by-tab-id="startSectionByTabId"
                :tab-lifecycle-by-id="tabLifecycleById"
                :view-state-by-tab-id="viewStateByTabId"
                :document-records-by-tab-id="documentRecordsByTabId"
                :document-sessions-by-tab-id="documentSessionsByTabId"
                :zen-mode="isFullscreen"
                :zen-active-tab-id="activeTabId"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                :is-workspace-layout-resizing="isAssistantPanelResizing"
                @activate-pane="activatePane"
                @activate-tab="activateTab"
                @close-tab="handleCloseTab"
                @new-tab="createTabInPane"
                @reorder-tab="moveTabWithinPane"
                @move-tab-direction="handleTabMoveDirection"
                @tab-context-command="handleTabContextCommand"
                @set-workspace-ref="setWorkspaceRef"
                @update-document-record="handleDocumentRecordUpdate"
                @update-tab-session-state="updateTabViewState"
                @update-tab-start-section="setTabStartSection"
                @open-in-new-tab="handleOpenInNewTab"
                @request-close-tab="handleCloseTab"
                @open-settings="openSettingsPage"
                @open-combine="openCombinePage"
                @toggle-fullscreen="handleToggleFullscreen"
                @update-split-ratio="setSplitRatio"
            />
            <AgentAssistantPanel
                v-if="assistantPanelEnabled && assistantPanelOpen && !isFullscreen"
                :chat-scope="assistantChatScope"
                :has-active-document="assistantHasActiveDocument"
                :has-any-document="assistantHasAnyDocument"
                :active-document-name="assistantActiveDocumentName"
                :width="assistantPanelWidth"
                :is-resizing="isAssistantPanelResizing"
                @resize-start="startAssistantPanelResize"
                @close="assistantPanelOpen = false"
            />
        </div>

        <CombinePdfPage
            v-if="activeToolPage === 'combine'"
            @close="closeToolPage"
            @open-result="handleCombineOpenResult"
        />

        <div v-show="!activeToolPage" id="editor-global-status-host" class="editor-global-status-host" />
        <DirtyTabCloseDialog
            :open="dirtyTabCloseDialogOpen"
            :target-name="dirtyTabCloseTargetName"
            @update:open="dirtyTabCloseDialogOpen = $event"
            @confirm="confirmDirtyTabClose"
        />
        <AppUpdatesDialog
            :open="updatesDialog.open"
            :title="updatesDialogTitle"
            :description="updatesDialogDescription"
            :progress-percent="updatesDialog.phase === 'downloading' ? updatesDialog.percent : null"
            :ready="updatesDialog.kind === 'ready'"
            @update:open="updatesDialog.open = $event"
            @defer="handleDeferUpdate"
            @skip="handleSkipUpdate"
            @install="handleInstallUpdate"
        />
    </div>
</template>

<script setup lang="ts">
import { useEventListener } from '@vueuse/core';
import { logicNot } from '@vueuse/math';
import { guardAsync } from '@app/utils/asyncGuard';
import { BrowserLogger } from '@app/utils/browserLogger';
import { resolveAppWindowTitle } from '@app/utils/appWindowTitle';
import { traceRendererStartup } from '@app/utils/traceRendererStartup';
import { syncBrowserWindowTitle } from '@app/platform/browserWindowTabs';
import { AgentAssistantPanel } from '@app/modules/agent-panel/public';
import CombinePdfPage from '@app/components/combine/CombinePdfPage.vue';
import AppUpdatesDialog from '@app/modules/workspace-shell/components/AppUpdatesDialog.vue';
import DirtyTabCloseDialog from '@app/modules/workspace-shell/components/DirtyTabCloseDialog.vue';
import EditorPanesHost from '@app/modules/workspace-shell/components/EditorPanesHost.vue';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/tabs/tabHasDocumentHint';
import ShellWorkspaceToolbar from '@app/modules/workspace-shell/components/ShellWorkspaceToolbar.vue';
import { useAppShellDirectionalTabs } from '@app/modules/workspace-shell/composables/useAppShellDirectionalTabs';
import { useAppShellLifecycle } from '@app/modules/workspace-shell/composables/useAppShellLifecycle';
import { useAppShellTabLifecycle } from '@app/modules/workspace-shell/composables/useAppShellTabLifecycle';
import { useAppShellUpdatesDialog } from '@app/modules/workspace-shell/composables/useAppShellUpdatesDialog';
import { useAppShellWorkspaceRouting } from '@app/modules/workspace-shell/composables/useAppShellWorkspaceRouting';
import { useExternalFileDrop } from '@app/modules/workspace-shell/composables/useExternalFileDrop';
import { useDirtyTabCloseDialog } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';
import { useShellWorkspaceToolbar } from '@app/modules/workspace-shell/composables/useShellWorkspaceToolbar';
import { useMenuSync } from '@app/modules/workspace-shell/composables/useMenuSync';
import { useWorkspaceShellState } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import { useWorkspaceDocumentSessions } from '@app/modules/workspace-shell/document-sessions/useWorkspaceDocumentSessions';
import { hasWorkspaceViewerDocumentCapabilities } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import { useWorkspaceToolbarContentPresence } from '@app/modules/workspace-shell/composables/useWorkspaceToolbarContentPresence';
import { useTabsShellBindings } from '@app/modules/workspace-shell/composables/useTabsShellBindings';
import { useAgentWorkspaceSnapshot } from '@app/modules/workspace-shell/composables/useAgentWorkspaceSnapshot';
import { useAssistantPanelResize } from '@app/modules/workspace-shell/composables/useAssistantPanelResize';
import { useAppUpdates } from '@app/composables/useAppUpdates';
import { useAnalytics } from '@app/composables/useAnalytics';
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';
import { useEditorPanesManager } from '@app/modules/workspace-shell/composables/useEditorPanesManager';
import { useWorkspaceRestoreTracker } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import { useWindowTabTransfers } from '@app/modules/workspace-shell/composables/useWindowTabTransfers';
import { useBrowserInstallHint } from '@app/modules/workspace-shell/composables/useBrowserInstallHint';
import { useDirectOpenAutomationDispatcherShell } from '@app/modules/workspace-shell/automation/directOpenAutomationDispatcher';
import { resolveTabLifecycleStates } from '@app/modules/workspace-shell/tabs/resolveTabLifecycleStates';
import { pruneStartSectionByTabId } from '@app/modules/workspace-shell/tabs/pruneStartSectionByTabId';
import type {
    TPdfViewMode,
    TTabMemoryPolicy,
} from '@contracts/shared';
import type { IAgentAssistantChatScope } from '@contracts/agent';
import type { TStartSection } from '@app/types/startSection';
import type { IHostZenModeState } from '@contracts/electronApiHost';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { getHostCapability } from '@app/utils/getHostCapability';
import { waitForDesktopPlatformBridge } from '@app/utils/platform';
import { getDocumentWindowCapability } from '@app/utils/platformDocuments';
import { resolveDocumentRefBackend } from '@app/utils/documentRef';
import {
    invokeWorkspaceExposeCommand,
    workspaceExposeToolbarCommandDescriptors,
    WorkspaceExposeCommandUnavailableError,
    type TWorkspaceExposeMethod,
} from '@app/modules/workspace-shell/expose/workspaceExposeDescriptors';

traceRendererStartup('index.vue script setup start');
useDirectOpenAutomationDispatcherShell();

const {
    panes,
    tabs,
    layout,
    activePaneId,
    activeTabId,
    ensureAtLeastOneTab,
    getPaneById,
    getTabById,
    getPaneByTabId,
    activatePane,
    activateTab: activateEditorTab,
    createTab,
    closeTab,
    moveTabWithinPane,
    splitPane,
    closePane,
    setSplitRatio,
    focusPane,
    findDirectionalPane,
    moveTabToPane,
} = useEditorPanesManager();

ensureAtLeastOneTab();

const { t } = useTypedI18n();
const {
    settings: appSettings,
    updateSetting,
} = useSettings();
const analytics = useAnalytics();
const activeToolPage = ref<'combine' | null>(null);
const startSectionByTabId = ref<Record<string, TStartSection>>({});
const isStartupOpenClaimPending = ref(true);
const {
    isBrowserRuntime,
    isDesktopRuntime,
} = useRuntimeEnvironment();
const {
    browserInstallUrl,
    dismissBrowserInstallHint,
    handleBrowserInstallHintClick,
    showBrowserInstallHint,
} = useBrowserInstallHint({
    analytics,
    isBrowserRuntime,
});
const shouldWaitForDesktopBridge = logicNot(isBrowserRuntime);
const isFullscreen = ref(false);
const assistantPanel = useAssistantPanel();
const assistantPanelOpen = assistantPanel.isOpen;
const {
    panelWidth: assistantPanelWidth,
    isResizingPanel: isAssistantPanelResizing,
    startPanelResize: startAssistantPanelResize,
} = useAssistantPanelResize();
const fullscreenSupported = ref(true);
let zenModeRequestInFlight = false;
const workspaceSplitCache = useWorkspaceSplitCache();
const tabActivationOrder = ref<string[]>([]);
watch(activeTabId, (tabId) => {
    if (!tabId) {
        return;
    }

    tabActivationOrder.value = [
        tabId,
        ...tabActivationOrder.value.filter(candidate => candidate !== tabId),
    ];
}, { immediate: true });
watch(tabs, (nextTabs) => {
    const tabIds = new Set(nextTabs.map(tab => tab.id));
    tabActivationOrder.value = tabActivationOrder.value.filter(tabId => tabIds.has(tabId));
    const nextStartSectionByTabId = pruneStartSectionByTabId(startSectionByTabId.value, nextTabs);
    if (nextStartSectionByTabId !== startSectionByTabId.value) {
        startSectionByTabId.value = nextStartSectionByTabId;
    }
});
const tabLifecycleById = computed(() => Object.fromEntries(
    resolveTabLifecycleStates({
        activeTabId: activeTabId.value,
        activationOrder: tabActivationOrder.value,
        panes: panes.value,
        policy: appSettings.value.tabMemoryPolicy,
        tabs: tabs.value,
    }).map(state => [
        state.tabId,
        state,
    ]),
));
const workspaceRestoreTracker = useWorkspaceRestoreTracker();
const {
    checkForUpdates,
    closeDialog: closeUpdatesDialog,
    deferUpdate,
    dialog: updatesDialog,
    dialogVersion: updatesDialogVersion,
    ensureInitialized: ensureUpdatesInitialized,
    installUpdateNow,
    skipUpdateVersion,
} = useAppUpdates();

const {
    dirtyTabCloseDialogOpen,
    dirtyTabCloseTargetName,
    confirmDirtyTabClose,
    requestDirtyTabCloseConfirmation,
    resolveDirtyTabCloseDialog,
} = useDirtyTabCloseDialog({tabs});

const {
    activeDocumentRecord,
    activeWorkspace,
    documentRecordsByTabId,
    documentSessionsByTabId,
    applyViewState: applySessionViewState,
    getDocumentRecord,
    removeDocumentRecord: removeSessionDocumentRecord,
    seedTabDocumentRecord: seedSessionTabDocumentRecord,
    setWorkspaceDocumentRecord: setSessionWorkspaceDocumentRecord,
    setWorkspaceRef: setSessionWorkspaceRef,
    viewStateByTabId,
    waitForWorkspace,
    workspaceRefs,
} = useWorkspaceDocumentSessions({
    activeTabId,
    tabs,
});
function updateTabViewState(tabId: string, state: IWorkspaceDocumentRecord['viewState']) {
    applySessionViewState(tabId, state);
}

function setWorkspaceRef(tabId: string, el: unknown) {
    setSessionWorkspaceRef(tabId, el);
}

const globalToolbarHostRef = ref<HTMLElement | null>(null);
const { hasWorkspaceToolbarContent } = useWorkspaceToolbarContentPresence(globalToolbarHostRef);
function activateTab(paneId: string, tabId: string) {
    activateEditorTab(paneId, tabId);
}
const activeTab = computed(() => activeTabId.value ? getTabById(activeTabId.value) : null);
const shellState = useWorkspaceShellState({
    activeDocumentRecord,
    activeTabId,
    tabs,
});
const {
    isTabTransitionBusy,
    enqueueTabTransition,
    updateTab: updateTabInState,
    removeTabFromState: removeTabFromLifecycleState,
    cleanupEmptyPanes,
    isSingletonPlaceholderCloseBlocked,
    resolveTabForAction,
    closeTabInState: closeTabInLifecycleState,
    handoffActiveTabBeforeClose,
    handleCloseTab,
} = useAppShellTabLifecycle({
    panes,
    tabs,
    activePaneId,
    activeTabId,
    workspaceRefs,
    documentSessionsByTabId,
    getDocumentRecord,
    workspaceSplitCache,
    workspaceRestoreTracker,
    getPaneById,
    getTabById,
    getPaneByTabId: (tabId) => (tabId ? getPaneByTabId(tabId) : null),
    activatePane,
    activateTab,
    closeTab,
    closePane,
    requestDirtyTabCloseConfirmation,
});
function updateTab(tabId: string, updates: Partial<ITab>) {
    updateTabInState(tabId, updates);
    seedSessionTabDocumentRecord(tabId, updates);
}

function removeTabFromState(tabId: string) {
    removeSessionDocumentRecord(tabId);
    removeTabFromLifecycleState(tabId);
}

function closeTabInState(paneId: string, tabId: string) {
    removeSessionDocumentRecord(tabId);
    closeTabInLifecycleState(paneId, tabId);
}

function handleDocumentRecordUpdate(tabId: string, record: IWorkspaceDocumentRecord) {
    setSessionWorkspaceDocumentRecord(tabId, record);
    const sessionRecord = getDocumentRecord(tabId) ?? record;
    updateTabInState(tabId, sessionRecord.tab);
}

function runFallbackWorkspaceCommand(commandName: TWorkspaceExposeMethod, args: readonly unknown[] = []) {
    const workspace = activeWorkspace.value;
    if (!workspace) {
        BrowserLogger.error('shell', 'Fallback workspace command unavailable', {error: new WorkspaceExposeCommandUnavailableError(commandName)});
        return;
    }

    const result: unknown = invokeWorkspaceExposeCommand(workspace, commandName, args);
    if (result instanceof Promise) {
        guardAsync(result, {
            category: 'user-visible-operation',
            scope: 'shell',
            message: `Fallback workspace command failed: ${commandName}`,
        });
    }
}

const fallbackToolbarCommandListeners = Object.fromEntries(
    workspaceExposeToolbarCommandDescriptors.map(descriptor => [
        descriptor.toolbar.eventName,
        (...args: unknown[]) => runFallbackWorkspaceCommand(descriptor.name, args),
    ]),
);

function activeWorkspaceHasDocument() {
    return shellState.activeWorkspaceHasDocument.value;
}

function handleToggleFullscreen() {
    if (!fullscreenSupported.value || (!isFullscreen.value && !activeWorkspaceHasDocument())) {
        return;
    }

    setZenMode(!isFullscreen.value);
}

function applyZenModeState(state: IHostZenModeState) {
    fullscreenSupported.value = state.supported;
    isFullscreen.value = state.active;
}

function setZenMode(active: boolean) {
    if (zenModeRequestInFlight || active === isFullscreen.value) {
        return;
    }

    const previousActive = isFullscreen.value;
    if (active) {
        isFullscreen.value = true;
    }
    zenModeRequestInFlight = true;

    guardAsync(
        getHostCapability().setZenMode(active)
            .then(applyZenModeState)
            .catch((error: unknown) => {
                isFullscreen.value = previousActive;
                throw error;
            })
            .finally(() => {
                zenModeRequestInFlight = false;
            }),
        {
            category: 'user-visible-operation',
            scope: 'shell',
            message: 'Failed to toggle zen mode',
        },
    );
}

useEventListener(window, 'keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !isFullscreen.value) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    setZenMode(false);
}, { capture: true });

let unsubscribeZenModeChange: (() => void) | null = null;
let isShellRootDisposed = false;

onMounted(() => {
    isShellRootDisposed = false;
    guardAsync(
        (async () => {
            await waitForDesktopPlatformBridge({ shouldWait: !isBrowserRuntime.value });
            if (isShellRootDisposed) {
                return;
            }
            await getHostCapability().getZenModeState().then(applyZenModeState);
            if (isShellRootDisposed) {
                return;
            }
            const unsubscribe = getHostCapability().onZenModeChange(applyZenModeState);
            if (isShellRootDisposed) {
                unsubscribe();
                return;
            }
            unsubscribeZenModeChange = unsubscribe;
        })(),
        {
            category: 'background-diagnostic',
            scope: 'shell',
            message: 'Failed to read zen mode state',
        },
    );

    if (import.meta.dev) {
        (window as Window & {__setTabMemoryPolicyForE2E?: (policy: TTabMemoryPolicy) => void;}).__setTabMemoryPolicyForE2E = (policy) => updateSetting('tabMemoryPolicy', policy);
        (window as Window & {__splitEditorForE2E?: (direction: 'left' | 'right' | 'up' | 'down') => Promise<void> | void;}).__splitEditorForE2E = splitEditor;
        (window as Window & {__splitEditorEmptyForE2E?: (direction: 'left' | 'right' | 'up' | 'down') => Promise<void> | void;}).__splitEditorEmptyForE2E = splitEditorEmpty;
        (window as Window & {__copyActiveTabForE2E?: (direction: 'left' | 'right' | 'up' | 'down') => Promise<void> | void;}).__copyActiveTabForE2E = copyActiveTab;
    }
});

onUnmounted(() => {
    isShellRootDisposed = true;
    unsubscribeZenModeChange?.();
    unsubscribeZenModeChange = null;
    if (import.meta.dev) {
        delete (window as Window & {__setTabMemoryPolicyForE2E?: (policy: TTabMemoryPolicy) => void;}).__setTabMemoryPolicyForE2E;
        delete (window as Window & {__splitEditorForE2E?: (direction: 'left' | 'right' | 'up' | 'down') => Promise<void> | void;}).__splitEditorForE2E;
        delete (window as Window & {__splitEditorEmptyForE2E?: (direction: 'left' | 'right' | 'up' | 'down') => Promise<void> | void;}).__splitEditorEmptyForE2E;
        delete (window as Window & {__copyActiveTabForE2E?: (direction: 'left' | 'right' | 'up' | 'down') => Promise<void> | void;}).__copyActiveTabForE2E;
    }
});

const {
    shellToolbarAppMenuOpen,
    shellToolbarCurrentPage,
    shellToolbarEffectiveZoom,
    shellToolbarFitMode,
    shellToolbarHasPdf,
    shellToolbarOcrPopupOpen,
    shellToolbarOverflowMenuOpen,
    shellToolbarPageDropdownOpen,
    shellToolbarSnapshot,
    shellToolbarViewMode,
    shellToolbarZoom,
    shellToolbarZoomMode,
    shellToolbarZoomDropdownOpen,
    handleShellToolbarOverflowSetViewMode: handleShellToolbarOverflowSetViewModeInternal,
    showShellToolbar,
} = useShellWorkspaceToolbar({
    activeDocumentRecord,
    hasWorkspaceToolbarContent,
});

function handleShellToolbarOverflowSetViewMode(mode: TPdfViewMode) {
    handleShellToolbarOverflowSetViewModeInternal(mode, runFallbackWorkspaceCommand);
}

useMenuSync({
    activeDocumentRecord,
    activeTabId,
    tabs,
    shellState,
});

const {
    handleDeferUpdate,
    handleInstallUpdate,
    handleSkipUpdate,
    updatesDialogDescription,
    updatesDialogTitle,
} = useAppShellUpdatesDialog({
    updatesDialog,
    updatesDialogVersion,
    closeUpdatesDialog,
    deferUpdate,
    skipUpdateVersion,
    installUpdateNow,
});

const {
    captureWorkspacePayload,
    restoreWorkspacePayload,
    handleIncomingTabTransfer,
    moveTabToNewWindow,
    moveTabToWindow,
    mergeWindowInto,
} = useWindowTabTransfers({
    activePaneId,
    panes,
    tabs,
    layout,
    createTab,
    getPaneById,
    getTabById,
    getPaneByTabId,
    activatePane,
    activateTab,
    removeTabFromState,
    cleanupEmptyPanes,
    closeTabInState,
    workspaceRefs,
    documentSessionsByTabId,
    waitForWorkspace,
    updateTab,
    workspaceRestoreTracker,
    handleCloseTab,
    handoffActiveTabBeforeClose,
});
const {
    createTabInPane: createTabInPaneFromRouting,
    handleFallbackToolbarOpenFile,
    handleOpenInNewTab,
    openResultInAppropriateTab,
    openPathInAppropriateTab,
    openPathsInAppropriateTab,
    beginOpenPathsInAppropriateTab,
    handleWindowTabsAction,
} = useAppShellWorkspaceRouting({
    activePaneId,
    activeTabId,
    activeWorkspace,
    workspaceRefs,
    waitForWorkspace,
    getDocumentRecord,
    createTab,
    getTabById,
    updateTab,
    removeTabFromState,
    resolveTabForAction,
    handleCloseTab,
    moveTabToNewWindow,
    moveTabToWindow,
    mergeWindowInto,
});
function createTabInPane(paneId: string) {
    createTabInPaneFromRouting(paneId);
}

function setTabStartSection(tabId: string, section: TStartSection) {
    startSectionByTabId.value = {
        ...startSectionByTabId.value,
        [tabId]: section,
    };
}

function isTabEmpty(tabId: string) {
    const tab = getTabById(tabId);
    const record = getDocumentRecord(tabId);
    if (!tab || (record?.tab && tabHasDocumentHint(record.tab)) || tabHasDocumentHint(tab)) {
        return false;
    }
    const snapshot = record?.toolbarSnapshot;
    return !hasWorkspaceViewerDocumentCapabilities(snapshot?.viewerCapabilities) && !snapshot?.isOpeningDocument && !snapshot?.hasOpenError;
}

const assistantActiveTab = computed(() => activeTabId.value ? getTabById(activeTabId.value) : null);
const assistantHasActiveDocument = computed(() => (
    assistantActiveTab.value ? !isTabEmpty(assistantActiveTab.value.id) : false
));
const assistantHasAnyDocument = computed(() => tabs.value.some(tab => !isTabEmpty(tab.id)));
const assistantActiveDocumentName = computed(() => assistantHasActiveDocument.value
    ? assistantActiveTab.value?.fileName ?? null
    : null);
const assistantChatScope = computed<IAgentAssistantChatScope | null>(() => {
    const tab = assistantActiveTab.value;
    if (!tab || !assistantHasActiveDocument.value) {
        return null;
    }

    const session = documentSessionsByTabId.value[tab.id] ?? null;
    const identity = session ? unref(session.snapshot).identity : null;
    const documentSessionKey = identity?.documentSessionKey ?? null;
    const documentInstanceId = identity?.documentInstanceId ?? null;
    const documentRef = tab.originalPath;
    const documentBackend = resolveDocumentRefBackend(documentRef);
    const documentIdentity = activeDocumentRecord.value?.documentIdentity ?? null;
    const commandTarget = session?.createCommandTarget();
    const title = tab.fileName ?? documentRef ?? null;
    return {
        kind: 'document',
        key: documentSessionKey
            ? `document-session:${documentSessionKey}`
            : documentRef
                ? `document:${documentBackend ?? 'unknown'}:${documentRef}`
                : `tab:${tab.id}`,
        title,
        tabId: tab.id,
        ...(documentSessionKey ? { documentSessionKey } : {}),
        ...(documentInstanceId ? { documentInstanceId } : {}),
        ...(documentRef ? { documentRef } : {}),
        ...(documentBackend === undefined ? {} : {documentBackend}),
        ...(documentIdentity ? { documentIdentity } : {}),
        ...(commandTarget ? { commandTarget } : {}),
    };
});
const assistantPanelEnabled = computed(() => isDesktopRuntime.value && appSettings.value.assistantPanelEnabled);

watch(assistantPanelEnabled, (enabled) => {
    if (!enabled) {
        assistantPanelOpen.value = false;
    }
});

watchEffect(() => {
    assistantPanel.isEnabled.value = assistantPanelEnabled.value && !isFullscreen.value;
    assistantPanel.hasActiveDocument.value = assistantHasActiveDocument.value;
});

function findEmptyTab() {
    if (activeTabId.value && isTabEmpty(activeTabId.value)) {
        return getTabById(activeTabId.value);
    }

    return tabs.value.find(tab => isTabEmpty(tab.id)) ?? null;
}

function activateTabById(tabId: string) {
    const pane = getPaneByTabId(tabId);
    if (!pane) {
        return;
    }

    activateTab(pane.paneId, tabId);
}

const {
    recentFiles,
    isResolved: recentFilesResolved,
    loadRecentFiles,
    clearRecentFiles,
} = useRecentFiles();

useAgentWorkspaceSnapshot({
    panes,
    tabs,
    layout,
    activePaneId,
    activeTabId,
    recentFiles,
    recentFilesResolved,
    workspaceRefs,
    documentRecordsByTabId,
    documentSessionsByTabId,
    shouldWaitForDesktopBridge: () => shouldWaitForDesktopBridge.value,
    getPaneByTabId,
    activateTab,
    waitForWorkspace,
});

function openSettingsPage() {
    activeToolPage.value = null;
    const settingsTab = findEmptyTab() ?? createTab({
        paneId: activePaneId.value,
        activate: true,
    });

    setTabStartSection(settingsTab.id, 'settings');
    activateTabById(settingsTab.id);
}

function openCombinePage() {
    activeToolPage.value = 'combine';
}

function closeToolPage() {
    activeToolPage.value = null;
}

function handleCombineOpenResult(result: TOpenFileResult) {
    closeToolPage();
    guardAsync(openResultInAppropriateTab(result), {
        category: 'user-visible-operation',
        scope: 'shell',
        message: 'Failed to open combined PDF',
    });
}
const {
    tabContextAvailabilityByPane,
    splitEditor,
    splitEditorEmpty,
    focusEditorPane,
    moveActiveTab,
    copyActiveTab,
    handleTabContextCommand,
    handleTabMoveDirection,
    cleanup: cleanupDirectionalTabs,
} = useAppShellDirectionalTabs({
    activePaneId,
    panes,
    tabs,
    workspaceRefs,
    documentSessionsByTabId,
    getDocumentRecord,
    isTabTransitionBusy,
    getPaneById,
    getTabById,
    findDirectionalPane,
    focusPane,
    splitPane,
    moveTabToPane,
    createTab,
    activatePane,
    activateTab,
    removeTabFromState,
    cleanupEmptyPanes,
    workspaceSplitCache,
    isSingletonPlaceholderCloseBlocked,
    enqueueTabTransition,
    captureWorkspacePayload,
    restoreWorkspacePayload,
    moveTabToNewWindow,
    moveTabToWindow,
    handleCloseTab,
});

const { cleanup: cleanupExternalFileDrop } = useExternalFileDrop({
    openPathsInAppropriateTab,
    isEnabled: computed(() => activeToolPage.value === null),
});

const windowTitle = computed(() => resolveAppWindowTitle({
    appTitle: t('app.title'),
    webTitle: t('app.webTitle'),
    fileName: activeTab.value?.fileName ?? null,
    isBrowserRuntime: isBrowserRuntime.value,
}));

let windowTitleSyncGeneration = 0;
watch(windowTitle, (nextTitle) => {
    if (!import.meta.client) {
        return;
    }

    if (isBrowserRuntime.value) {
        if (typeof document === 'undefined' || document.title === nextTitle) {
            return;
        }

        document.title = nextTitle;
        syncBrowserWindowTitle();
        return;
    }

    const generation = ++windowTitleSyncGeneration;
    guardAsync((async () => {
        await waitForDesktopPlatformBridge({ shouldWait: true });
        if (generation !== windowTitleSyncGeneration || nextTitle !== windowTitle.value) {
            return;
        }
        await getDocumentWindowCapability().setWindowTitle(nextTitle);
    })(), {
        category: 'background-diagnostic',
        scope: 'window-title',
        message: 'Failed to sync window title',
    });
}, { immediate: true });

useTabsShellBindings({
    tabs,
    workspaceRefs,
    documentRecordsByTabId,
    activeTabId,
    activeWorkspace,
    createTab: () => {
        return createTab({ activate: true });
    },
    activateTab: (tabId) => {
        const pane = getPaneByTabId(tabId);
        if (pane) {
            activateTab(pane.paneId, tabId);
        }
    },
    handleCloseTab: async (tabId) => {
        const pane = getPaneByTabId(tabId);
        if (!pane) {
            return;
        }
        await handleCloseTab(pane.paneId, tabId);
    },
    handleFallbackToolbarOpenFile,
    openPathInAppropriateTab,
    openPathsInAppropriateTab,
    beginOpenPathsInAppropriateTab,
    clearRecentFiles,
    loadRecentFiles,
    isStartupOpenClaimPending,
    openSettings: openSettingsPage,
    checkForUpdates,
    splitEditor,
    focusPane: focusEditorPane,
    moveActiveTab,
    copyActiveTab,
    handleWindowTabsAction,
    toggleAssistant: () => assistantPanel.toggle(),
});

traceRendererStartup('index.vue setup wiring complete');
useAppShellLifecycle({
    dirtyTabCloseDialogOpen,
    updatesDialogOpen: computed(() => updatesDialog.value.open),
    cleanupEmptyPanes,
    ensureUpdatesInitialized: async () => {
        await ensureUpdatesInitialized();
    },
    handleIncomingTabTransfer,
    cleanupDirectionalTabs,
    cleanupExternalFileDrop,
    resolveDirtyTabCloseDialog,
    closeUpdatesDialog,
});
</script>

<style scoped src="./AppShellRoot.css"></style>
