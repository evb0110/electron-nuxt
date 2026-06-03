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
            <FallbackWorkspaceToolbar
                v-show="showFallbackToolbar"
                :snapshot="fallbackToolbarSnapshot"
                :has-pdf="fallbackHasPdf"
                :ocr-popup-open="fallbackOcrPopupOpen"
                :zoom-dropdown-open="fallbackZoomDropdownOpen"
                :page-dropdown-open="fallbackPageDropdownOpen"
                :overflow-menu-open="fallbackOverflowMenuOpen"
                :app-menu-open="fallbackAppMenuOpen"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                @update:ocr-popup-open="fallbackOcrPopupOpen = $event"
                @update:zoom-dropdown-open="fallbackZoomDropdownOpen = $event"
                @update:page-dropdown-open="fallbackPageDropdownOpen = $event"
                @update:overflow-menu-open="fallbackOverflowMenuOpen = $event"
                @update:app-menu-open="fallbackAppMenuOpen = $event"
                @update:zoom="fallbackZoom = $event"
                @update:effective-zoom="fallbackEffectiveZoom = $event"
                @update:zoom-mode="fallbackZoomMode = $event"
                @update:fit-mode="fallbackFitMode = $event"
                @update:view-mode="fallbackViewMode = $event"
                @update:current-page="fallbackCurrentPage = $event"
                @open-file="handleFallbackToolbarOpenFile"
                @open-settings="openSettingsPage"
                @save="handleFallbackSave"
                @repair-save="handleFallbackRepairSave"
                @save-as="handleFallbackSaveAs"
                @print="handleFallbackPrint"
                @print-current-page="handleFallbackPrintCurrentPage"
                @combine-images="openCombinePage"
                @export-docx="handleFallbackExportDocx"
                @export-images="handleFallbackExportImages"
                @export-multi-page-tiff="handleFallbackExportMultiPageTiff"
                @convert-to-pdf="handleFallbackConvertToPdf"
                @undo="handleFallbackUndo"
                @redo="handleFallbackRedo"
                @insert-image-from-file="handleFallbackInsertImageFromFile"
                @paste-image-from-clipboard="handleFallbackPasteImageFromClipboard"
                @delete-pages="handleFallbackDeletePages"
                @extract-pages="handleFallbackExtractPages"
                @rotate-cw="handleFallbackRotateCw"
                @rotate-ccw="handleFallbackRotateCcw"
                @insert-pages="handleFallbackInsertPages"
                @toggle-sidebar="handleFallbackToggleSidebar"
                @actual-size="handleFallbackActualSize"
                @fit-width="handleFallbackFitWidth"
                @fit-height="handleFallbackFitHeight"
                @toggle-continuous-scroll="handleFallbackToggleContinuousScroll"
                @enable-drag="handleFallbackEnableDragMode"
                @disable-drag="handleFallbackDisableDragMode"
                @capture-region="handleFallbackCaptureRegion"
                @quick-note="handleFallbackQuickNote"
                @toggle-fullscreen="handleToggleFullscreen"
                @set-view-mode="handleFallbackOverflowSetViewMode"
                @go-to-page="noopFallbackAction"
                @ocr-complete="noopFallbackAction"
            />
            <div
                v-show="!showFallbackToolbar"
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
                :zen-mode="isFullscreen"
                :zen-active-tab-id="activeTabId"
                :is-fullscreen="isFullscreen"
                :fullscreen-supported="fullscreenSupported"
                @activate-pane="activatePane"
                @activate-tab="activateTab"
                @close-tab="handleCloseTab"
                @new-tab="createTabInPane"
                @reorder-tab="moveTabWithinPane"
                @move-tab-direction="handleTabMoveDirection"
                @tab-context-command="handleTabContextCommand"
                @set-workspace-ref="setWorkspaceRef"
                @update-tab="updateTab"
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
                :has-active-document="assistantHasActiveDocument"
                :has-any-document="assistantHasAnyDocument"
                :active-document-name="assistantActiveDocumentName"
                :width="assistantPanelWidth"
                :is-resizing="isAssistantPanelResizing"
                @resize-start="startAssistantPanelResize"
                @close="assistantPanelOpen = false"
            />
        </div>

        <UButton
            v-if="assistantPanelEnabled && !assistantPanelOpen && !activeToolPage && !isFullscreen"
            class="assistant-panel-toggle"
            :aria-label="t('assistant.open')"
            icon="i-ph-chat-circle-dots"
            color="neutral"
            variant="subtle"
            size="sm"
            @click="assistantPanelOpen = true"
        />

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
            :ready="updatesDialog.kind === 'ready'"
            @update:open="updatesDialog.open = $event"
            @defer="handleDeferUpdate"
            @skip="handleSkipUpdate"
            @install="handleInstallUpdate"
        />
    </div>
</template>

<script setup lang="ts">
import {
    useEventListener,
    useLocalStorage,
    useTimeoutFn,
} from '@vueuse/core';
import { logicNot } from '@vueuse/math';
import { guardAsync } from '@app/utils/asyncGuard';
import {
    BROWSER_INSTALL_HINT_COOKIE_KEY,
    BROWSER_INSTALL_HINT_STORAGE_KEY,
} from '@app/utils/browserRuntimePersistence';
import { resolveAppWindowTitle } from '@app/utils/appWindowTitle';
import { traceRendererStartup } from '@app/utils/startupTrace';
import { syncBrowserWindowTitle } from '@app/platform/browserWindowTabs';
import AgentAssistantPanel from '@app/components/agent/AgentAssistantPanel.vue';
import CombinePdfPage from '@app/components/combine/CombinePdfPage.vue';
import AppUpdatesDialog from '@app/modules/workspace-shell/components/AppUpdatesDialog.vue';
import DirtyTabCloseDialog from '@app/modules/workspace-shell/components/DirtyTabCloseDialog.vue';
import EditorPanesHost from '@app/modules/workspace-shell/components/EditorPanesHost.vue';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/composables/workspaceTabDocumentHint';
import FallbackWorkspaceToolbar from '@app/modules/workspace-shell/components/FallbackWorkspaceToolbar.vue';
import { useAppShellDirectionalTabs } from '@app/modules/workspace-shell/composables/useAppShellDirectionalTabs';
import { useAppShellLifecycle } from '@app/modules/workspace-shell/composables/useAppShellLifecycle';
import { useAppShellTabLifecycle } from '@app/modules/workspace-shell/composables/useAppShellTabLifecycle';
import { useAppShellUpdatesDialog } from '@app/modules/workspace-shell/composables/useAppShellUpdatesDialog';
import { useAppShellWorkspaceRouting } from '@app/modules/workspace-shell/composables/useAppShellWorkspaceRouting';
import { useExternalFileDrop } from '@app/modules/workspace-shell/composables/useExternalFileDrop';
import { useDirtyTabCloseDialog } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';
import { useFallbackWorkspaceToolbar } from '@app/modules/workspace-shell/composables/useFallbackWorkspaceToolbar';
import { useMenuSync } from '@app/modules/workspace-shell/composables/useMenuSync';
import { useWorkspaceShellState } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import { useToolbarTeleportBridge } from '@app/modules/workspace-shell/composables/useToolbarTeleportBridge';
import { useTabsShellBindings } from '@app/modules/workspace-shell/composables/useTabsShellBindings';
import { useWorkspaceRefRegistry } from '@app/modules/workspace-shell/composables/useWorkspaceRefRegistry';
import { useAgentWorkspaceSnapshot } from '@app/modules/workspace-shell/composables/useAgentWorkspaceSnapshot';
import { useAssistantPanelResize } from '@app/modules/workspace-shell/composables/useAssistantPanelResize';
import { useAppUpdates } from '@app/composables/useAppUpdates';
import { useAnalytics } from '@app/composables/useAnalytics';
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';
import { useEditorPanesManager } from '@app/modules/workspace-shell/composables/useEditorPanesManager';
import { useWorkspaceRestoreTracker } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import {
    createTabViewSessionState,
    useTabSessionStore,
} from '@app/modules/workspace-shell/composables/useTabSessionStore';
import { useWindowTabTransfers } from '@app/modules/workspace-shell/composables/useWindowTabTransfers';
import type {
    TPdfViewMode,
    TTabMemoryPolicy,
} from '@contracts/shared';
import type { TStartSection } from '@app/types/startPage';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IHostZenModeState } from '@contracts/electronApiHost';
import type { TOpenFileResult } from '@contracts/platformApi';
import {
    getPlatformAPI,
    waitForDesktopPlatformBridge,
} from '@app/utils/platform';

traceRendererStartup('index.vue script setup start');

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
const shouldWaitForDesktopBridge = logicNot(isBrowserRuntime);
const isFullscreen = ref(false);
const assistantPanelOpen = ref(false);
const {
    panelWidth: assistantPanelWidth,
    isResizingPanel: isAssistantPanelResizing,
    startPanelResize: startAssistantPanelResize,
} = useAssistantPanelResize();
const fullscreenSupported = ref(true);
let zenModeRequestInFlight = false;
const runtimeConfig = useRuntimeConfig();
const browserInstallHintCookie = useCookie<string | null>(
    BROWSER_INSTALL_HINT_COOKIE_KEY,
    {
        default: () => null,
        maxAge: 365 * 24 * 60 * 60,
    },
);
const browserInstallHintStorageDismissed = useLocalStorage(
    BROWSER_INSTALL_HINT_STORAGE_KEY,
    false,
);
const browserInstallHintDismissed = computed(() => (
    browserInstallHintCookie.value !== null
    || browserInstallHintStorageDismissed.value
));
const isBrowserInstallHintClientReady = ref(false);
const didTrackViewerSession = useState(
    'analytics:viewer-session-started',
    () => false,
);
const didTrackInstallHintShown = useState(
    'analytics:install-hint-shown',
    () => false,
);
const workspaceSplitCache = useWorkspaceSplitCache();
const {
    lifecycleByTabId: tabLifecycleById,
    updateViewState: updateTabViewState,
    viewStateByTabId,
} = useTabSessionStore({
    activeTabId,
    panes,
    policy: computed(() => appSettings.value.tabMemoryPolicy),
    tabs,
});
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
    activeWorkspace,
    setWorkspaceRef,
    waitForWorkspace,
    workspaceRefs,
} = useWorkspaceRefRegistry({ activeTabId });

function persistActiveTabViewState() {
    const tabId = activeTabId.value;
    const workspace = tabId ? workspaceRefs.value.get(tabId) : null;
    if (!tabId || !workspace) {
        return;
    }

    updateTabViewState(tabId, createTabViewSessionState(workspace.getToolbarSnapshot()));
}

function activateTab(paneId: string, tabId: string) {
    persistActiveTabViewState();
    activateEditorTab(paneId, tabId);
}

const activeTab = computed(() => (
    activeTabId.value
        ? getTabById(activeTabId.value)
        : null
));
const shellState = useWorkspaceShellState({
    activeWorkspace,
    activeTabId,
    tabs,
});
const hasTeleportedToolbarContentState = shallowRef(false);
const {
    isTabTransitionBusy,
    enqueueTabTransition,
    setAfterTransitionHook,
    updateTab,
    removeTabFromState,
    cleanupEmptyPanes,
    isSingletonPlaceholderCloseBlocked,
    resolveTabForAction,
    closeTabInState,
    handoffActiveTabBeforeClose,
    handleCloseTab,
} = useAppShellTabLifecycle({
    panes,
    tabs,
    activePaneId,
    activeTabId,
    workspaceRefs,
    hasTeleportedToolbarContent: hasTeleportedToolbarContentState,
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
const {
    globalToolbarHostRef,
    hasTeleportedToolbarContent,
    syncToolbarTeleportPresence,
    observeToolbarHost,
    disposeToolbarTeleportBridge,
} = useToolbarTeleportBridge(isTabTransitionBusy);
setAfterTransitionHook(syncToolbarTeleportPresence);
watchEffect(() => {
    hasTeleportedToolbarContentState.value = hasTeleportedToolbarContent.value;
});

function noopFallbackAction() {}

function runFallbackWorkspaceAction(action: (workspace: IWorkspaceExpose) => Promise<void> | void) {
    const workspace = activeWorkspace.value;
    if (!workspace) {
        return;
    }

    const result = action(workspace);
    if (result instanceof Promise) {
        guardAsync(result, {
            scope: 'shell',
            message: 'Fallback workspace action failed',
        });
    }
}

function handleFallbackSave() {
    runFallbackWorkspaceAction(workspace => workspace.handleSave());
}

function handleFallbackRepairSave() {
    runFallbackWorkspaceAction(workspace => workspace.handleRepairSave());
}

function handleFallbackSaveAs() {
    runFallbackWorkspaceAction(workspace => workspace.handleSaveAs());
}

function handleFallbackPrint() {
    runFallbackWorkspaceAction(workspace => workspace.handlePrint());
}

function handleFallbackPrintCurrentPage() {
    runFallbackWorkspaceAction(workspace => workspace.handlePrintCurrentPage());
}

function handleFallbackExportDocx() {
    runFallbackWorkspaceAction(workspace => workspace.handleExportDocx());
}

function handleFallbackExportImages() {
    runFallbackWorkspaceAction(workspace => workspace.handleExportImages());
}

function handleFallbackExportMultiPageTiff() {
    runFallbackWorkspaceAction(workspace => workspace.handleExportMultiPageTiff());
}

function handleFallbackConvertToPdf() {
    runFallbackWorkspaceAction(workspace => workspace.handleConvertToPdf());
}

function handleFallbackUndo() {
    runFallbackWorkspaceAction(workspace => workspace.handleUndo());
}

function handleFallbackRedo() {
    runFallbackWorkspaceAction(workspace => workspace.handleRedo());
}

function handleFallbackInsertImageFromFile() {
    runFallbackWorkspaceAction(workspace => workspace.handleInsertImageFromFile());
}

function handleFallbackPasteImageFromClipboard() {
    runFallbackWorkspaceAction(workspace => workspace.handlePasteImageFromClipboard());
}

function handleFallbackDeletePages() {
    runFallbackWorkspaceAction(workspace => workspace.handleDeletePages());
}

function handleFallbackExtractPages() {
    runFallbackWorkspaceAction(workspace => workspace.handleExtractPages());
}

function handleFallbackRotateCw() {
    runFallbackWorkspaceAction(workspace => workspace.handleRotateCw());
}

function handleFallbackRotateCcw() {
    runFallbackWorkspaceAction(workspace => workspace.handleRotateCcw());
}

function handleFallbackInsertPages() {
    runFallbackWorkspaceAction(workspace => workspace.handleInsertPages());
}

function handleFallbackToggleSidebar() {
    runFallbackWorkspaceAction(workspace => workspace.handleToggleSidebar());
}

function handleFallbackActualSize() {
    runFallbackWorkspaceAction(workspace => workspace.handleActualSize());
}

function handleFallbackFitWidth() {
    runFallbackWorkspaceAction(workspace => workspace.handleFitWidth());
}

function handleFallbackFitHeight() {
    runFallbackWorkspaceAction(workspace => workspace.handleFitHeight());
}

function handleFallbackToggleContinuousScroll() {
    runFallbackWorkspaceAction(workspace => workspace.handleToggleContinuousScroll());
}

function handleFallbackEnableDragMode() {
    runFallbackWorkspaceAction(workspace => workspace.handleEnableDragMode());
}

function handleFallbackDisableDragMode() {
    runFallbackWorkspaceAction(workspace => workspace.handleDisableDragMode());
}

function handleFallbackCaptureRegion() {
    runFallbackWorkspaceAction(workspace => workspace.handleCaptureRegion());
}

function handleFallbackQuickNote() {
    runFallbackWorkspaceAction(workspace => workspace.handleQuickNote());
}

function activeWorkspaceHasDocument() {
    const workspace = activeWorkspace.value;
    if (!workspace) {
        return false;
    }

    const snapshot = workspace.getToolbarSnapshot();
    return snapshot.hasPdf || snapshot.isDjvuMode;
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
        getPlatformAPI().host.setZenMode(active)
            .then(applyZenModeState)
            .catch((error: unknown) => {
                isFullscreen.value = previousActive;
                throw error;
            })
            .finally(() => {
                zenModeRequestInFlight = false;
            }),
        {
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

onMounted(() => {
    guardAsync(
        (async () => {
            await waitForDesktopPlatformBridge({ shouldWait: !isBrowserRuntime.value });
            await getPlatformAPI().host.getZenModeState().then(applyZenModeState);
            unsubscribeZenModeChange = getPlatformAPI().host.onZenModeChange(applyZenModeState);
        })(),
        {
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
    fallbackAppMenuOpen,
    fallbackCurrentPage,
    fallbackEffectiveZoom,
    fallbackFitMode,
    fallbackHasPdf,
    fallbackOcrPopupOpen,
    fallbackOverflowMenuOpen,
    fallbackPageDropdownOpen,
    fallbackToolbarSnapshot,
    fallbackViewMode,
    fallbackZoom,
    fallbackZoomMode,
    fallbackZoomDropdownOpen,
    handleFallbackOverflowSetViewMode: handleFallbackOverflowSetViewModeInternal,
    showFallbackToolbar,
} = useFallbackWorkspaceToolbar({
    activePaneId,
    activeTabId,
    activeWorkspace,
    hasTeleportedToolbarContent,
    isTabTransitionBusy,
    shellState,
});

function handleFallbackOverflowSetViewMode(mode: TPdfViewMode) {
    handleFallbackOverflowSetViewModeInternal(mode, runFallbackWorkspaceAction);
}

useMenuSync({
    activeWorkspace,
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
    waitForWorkspace,
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
    persistActiveTabViewState();
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
    if (!tab || tabHasDocumentHint(tab)) {
        return false;
    }

    const workspace = workspaceRefs.value.get(tab.id);
    if (!workspace) {
        return true;
    }

    const snapshot = workspace.getToolbarSnapshot();
    return !snapshot.hasPdf && !snapshot.isDjvuMode && !snapshot.isOpeningDocument && !snapshot.hasOpenError;
}

const assistantActiveTab = computed(() => activeTabId.value ? getTabById(activeTabId.value) : null);
const assistantHasActiveDocument = computed(() => (
    assistantActiveTab.value ? !isTabEmpty(assistantActiveTab.value.id) : false
));
const assistantHasAnyDocument = computed(() => tabs.value.some(tab => !isTabEmpty(tab.id)));
const assistantActiveDocumentName = computed(() => assistantHasActiveDocument.value
    ? assistantActiveTab.value?.fileName ?? null
    : null);
const assistantPanelEnabled = computed(() => isDesktopRuntime.value && appSettings.value.assistantPanelEnabled);

watch(assistantPanelEnabled, (enabled) => {
    if (!enabled) {
        assistantPanelOpen.value = false;
    }
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

const browserInstallUrl = computed(() => {
    if (!isBrowserRuntime.value) {
        return undefined;
    }

    const url = typeof runtimeConfig.public.landingUrl === 'string'
        ? runtimeConfig.public.landingUrl.trim()
        : '';
    return url || undefined;
});
const showBrowserInstallHint = computed(() => (
    isBrowserRuntime.value
    && isBrowserInstallHintClientReady.value
    && Boolean(browserInstallUrl.value)
    && !browserInstallHintDismissed.value
));

const windowTitle = computed(() => resolveAppWindowTitle({
    appTitle: t('app.title'),
    webTitle: t('app.webTitle'),
    fileName: activeTab.value?.fileName ?? null,
    isBrowserRuntime: isBrowserRuntime.value,
}));

function getBrowserInstallHost() {
    if (!browserInstallUrl.value) {
        return null;
    }

    try {
        return new URL(browserInstallUrl.value).host;
    } catch {
        return null;
    }
}

function trackBrowserInstallHint(action: 'shown' | 'clicked' | 'dismissed' | 'auto_dismissed') {
    analytics.track('browser_install_hint_interacted', {
        action,
        destinationHost: getBrowserInstallHost(),
    });
}

function handleBrowserInstallHintClick() {
    trackBrowserInstallHint('clicked');
}

function dismissBrowserInstallHint(reason: 'manual' | 'auto' = 'manual') {
    if (browserInstallHintDismissed.value) {
        return;
    }

    trackBrowserInstallHint(reason === 'auto' ? 'auto_dismissed' : 'dismissed');

    if (!import.meta.client || !isBrowserRuntime.value) {
        return;
    }

    browserInstallHintCookie.value = '1';
    browserInstallHintStorageDismissed.value = true;
}

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

    guardAsync((async () => {
        await waitForDesktopPlatformBridge({ shouldWait: true });
        await getPlatformAPI().documents.setWindowTitle(nextTitle);
    })(), {
        scope: 'window-title',
        message: 'Failed to sync window title',
    });
}, { immediate: true });

const BROWSER_INSTALL_HINT_AUTO_DISMISS_MS = 60_000;
const { start: startBrowserInstallHintAutoDismiss } = useTimeoutFn(
    () => dismissBrowserInstallHint('auto'),
    BROWSER_INSTALL_HINT_AUTO_DISMISS_MS,
    { immediate: false },
);

onMounted(() => {
    isBrowserInstallHintClientReady.value = true;

    if (isBrowserRuntime.value && !didTrackViewerSession.value) {
        didTrackViewerSession.value = true;
        analytics.track('viewer_session_started', {
            installHintVisible: showBrowserInstallHint.value,
            installHintDestinationHost: getBrowserInstallHost(),
        }, { includeReferrer: true });
    }

    if (!isBrowserRuntime.value || browserInstallHintDismissed.value) {
        return;
    }

    startBrowserInstallHintAutoDismiss();
});

watch(showBrowserInstallHint, (isVisible) => {
    if (!isBrowserRuntime.value || !isVisible || didTrackInstallHintShown.value) {
        return;
    }

    didTrackInstallHintShown.value = true;
    trackBrowserInstallHint('shown');
}, { immediate: true });

useTabsShellBindings({
    tabs,
    activeTabId,
    activeWorkspace,
    createTab: () => {
        persistActiveTabViewState();
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
});

traceRendererStartup('index.vue setup wiring complete');
useAppShellLifecycle({
    dirtyTabCloseDialogOpen,
    updatesDialogOpen: computed(() => updatesDialog.value.open),
    observeToolbarHost,
    cleanupEmptyPanes,
    ensureUpdatesInitialized,
    handleIncomingTabTransfer,
    cleanupDirectionalTabs,
    disposeToolbarTeleportBridge,
    cleanupExternalFileDrop,
    resolveDirtyTabCloseDialog,
    closeUpdatesDialog,
});
</script>

<style scoped>
.app-shell-root {
    position: relative;
}

.workspace-main-shell {
    position: relative;
    display: flex;
    flex: 1 1 0%;
    min-width: 0;
    min-height: 0;
}

.assistant-panel-toggle {
    position: fixed;
    right: 0.75rem;
    bottom: 2.25rem;
    z-index: 30;
    border-radius: 999px;
    box-shadow: var(--app-pdf-popover-shadow);
    opacity: 0.85;
    transition: opacity 0.15s ease;
}

.assistant-panel-toggle:hover {
    opacity: 1;
}

.browser-install-hint {
    position: fixed;
    bottom: 2.5rem;
    right: 1rem;
    z-index: 35;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    width: fit-content;
    max-width: calc(100vw - 2rem);
    padding: 0.25rem 0.25rem 0.25rem 0.5rem;
    border: 1px solid var(--ui-border);
    border-radius: 999px;
    background: var(--ui-bg);
    backdrop-filter: blur(12px);
    opacity: 0.65;
    transition: opacity 0.2s ease;
}

.browser-install-hint:hover {
    opacity: 1;
}

.browser-install-icon {
    flex: 0 0 auto;
    width: 14px;
    height: 14px;
    color: var(--ui-primary);
}

.browser-install-link {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
    max-width: 100%;
    padding: 0.125rem 0;
    border: 0;
    background: transparent;
    color: var(--ui-text-muted);
    font: inherit;
    text-decoration: none;
}

.browser-install-link:hover {
    color: var(--ui-text);
}

.browser-install-link-icon,
.browser-install-dismiss-icon {
    flex: 0 0 auto;
    width: 0.875rem;
    height: 0.875rem;
}

.browser-install-divider {
    width: 1px;
    height: 14px;
    background: var(--ui-border);
    flex: 0 0 auto;
}

.browser-install-dismiss {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--ui-text-dimmed);
}

.browser-install-dismiss:hover {
    color: var(--ui-text);
}

.install-hint-enter-active {
    transition: all 0.3s ease-out;
}

.install-hint-leave-active {
    transition: all 0.2s ease-in;
}

.install-hint-enter-from {
    opacity: 0;
    transform: translateY(6px);
}

.install-hint-leave-to {
    opacity: 0;
    transform: translateY(4px);
}

.editor-global-toolbar-shell,
.editor-global-toolbar-host {
    display: flex;
    flex-direction: column;
    min-height: 0;
}

.editor-global-status-host {
    display: flex;
    flex-direction: column;
    height: 1.9rem;
    min-height: 1.9rem;
    flex: 0 0 1.9rem;
}

.app-shell-root.is-zen-mode .browser-install-hint,
.app-shell-root.is-zen-mode .editor-global-toolbar-shell,
.app-shell-root.is-zen-mode .editor-global-status-host {
    display: none !important;
}

@media (width <= 900px) {
    .browser-install-hint {
        right: 0.75rem;
        bottom: 0.75rem;
    }
}
</style>
