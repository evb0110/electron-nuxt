<template>
    <div class="h-screen min-w-0 flex flex-col bg-[var(--app-window-bg)]">
        <div class="editor-global-toolbar-shell">
            <FallbackWorkspaceToolbar
                v-show="showFallbackToolbar"
                :snapshot="fallbackToolbarSnapshot"
                :has-pdf="fallbackHasPdf"
                :ocr-popup-open="fallbackOcrPopupOpen"
                :zoom-dropdown-open="fallbackZoomDropdownOpen"
                :page-dropdown-open="fallbackPageDropdownOpen"
                :overflow-menu-open="fallbackOverflowMenuOpen"
                @update:ocr-popup-open="fallbackOcrPopupOpen = $event"
                @update:zoom-dropdown-open="fallbackZoomDropdownOpen = $event"
                @update:page-dropdown-open="fallbackPageDropdownOpen = $event"
                @update:overflow-menu-open="fallbackOverflowMenuOpen = $event"
                @update:zoom="fallbackZoom = $event"
                @update:effective-zoom="fallbackEffectiveZoom = $event"
                @update:zoom-mode="fallbackZoomMode = $event"
                @update:fit-mode="fallbackFitMode = $event"
                @update:view-mode="fallbackViewMode = $event"
                @update:current-page="fallbackCurrentPage = $event"
                @open-file="handleFallbackToolbarOpenFile"
                @open-settings="showSettings = true"
                @save="runFallbackWorkspaceAction((workspace) => workspace.handleSave())"
                @save-as="runFallbackWorkspaceAction((workspace) => workspace.handleSaveAs())"
                @export-docx="runFallbackWorkspaceAction((workspace) => workspace.handleExportDocx())"
                @undo="runFallbackWorkspaceAction((workspace) => workspace.handleUndo())"
                @redo="runFallbackWorkspaceAction((workspace) => workspace.handleRedo())"
                @toggle-sidebar="runFallbackWorkspaceAction((workspace) => workspace.handleToggleSidebar())"
                @fit-width="runFallbackWorkspaceAction((workspace) => workspace.handleFitWidth())"
                @fit-height="runFallbackWorkspaceAction((workspace) => workspace.handleFitHeight())"
                @toggle-continuous-scroll="runFallbackWorkspaceAction((workspace) => workspace.handleToggleContinuousScroll())"
                @enable-drag="runFallbackWorkspaceAction((workspace) => workspace.handleEnableDragMode())"
                @disable-drag="runFallbackWorkspaceAction((workspace) => workspace.handleDisableDragMode())"
                @capture-region="runFallbackWorkspaceAction((workspace) => workspace.handleCaptureRegion())"
                @quick-note="runFallbackWorkspaceAction((workspace) => workspace.handleQuickNote())"
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

        <EditorGroupsHost
            :layout="layout"
            :chrome-hosts-ready="chromeHostsReady"
            :groups="groups"
            :tabs="tabs"
            :active-group-id="activeGroupId"
            :is-tab-transition-busy="isTabTransitionBusy"
            :tab-context-availability-by-group="tabContextAvailabilityByGroup"
            @activate-group="activateGroup"
            @activate-tab="activateTab"
            @close-tab="handleCloseTab"
            @new-tab="createTabInGroup"
            @reorder-tab="moveTabWithinGroup"
            @move-tab-direction="handleTabMoveDirection"
            @tab-context-command="handleTabContextCommand"
            @set-workspace-ref="setWorkspaceRef"
            @update-tab="updateTab"
            @open-in-new-tab="handleOpenInNewTab"
            @request-close-tab="handleCloseTab"
            @open-settings="showSettings = true"
            @update-split-ratio="setSplitRatio"
        />

        <div id="editor-global-status-host" class="editor-global-status-host" />

        <SettingsDialog v-if="showSettings" v-model:open="showSettings" />
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
import SettingsDialog from '@app/components/SettingsDialog.vue';
import { guardAsync } from '@app/utils/async-guard';
import { traceRendererStartup } from '@app/utils/startup-trace';
import AppUpdatesDialog from '@app/modules/workspace-shell/components/AppUpdatesDialog.vue';
import DirtyTabCloseDialog from '@app/modules/workspace-shell/components/DirtyTabCloseDialog.vue';
import EditorGroupsHost from '@app/modules/workspace-shell/components/EditorGroupsHost.vue';
import FallbackWorkspaceToolbar from '@app/modules/workspace-shell/components/FallbackWorkspaceToolbar.vue';
import { useAppShellDirectionalTabs } from '@app/modules/workspace-shell/composables/useAppShellDirectionalTabs';
import { useAppShellLifecycle } from '@app/modules/workspace-shell/composables/useAppShellLifecycle';
import { useAppShellTabLifecycle } from '@app/modules/workspace-shell/composables/useAppShellTabLifecycle';
import { useAppShellUpdatesDialog } from '@app/modules/workspace-shell/composables/useAppShellUpdatesDialog';
import { useAppShellWorkspaceRouting } from '@app/modules/workspace-shell/composables/useAppShellWorkspaceRouting';
import { useExternalFileDrop } from '@app/modules/workspace-shell/composables/useExternalFileDrop';
import { useDirtyTabCloseDialog } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';
import { useFallbackWorkspaceToolbar } from '@app/modules/workspace-shell/composables/useFallbackWorkspaceToolbar';
import {useMenuSync} from '@app/modules/workspace-shell/composables/useMenuSync';
import { useToolbarTeleportBridge } from '@app/modules/workspace-shell/composables/useToolbarTeleportBridge';
import { useTabsShellBindings } from '@app/modules/workspace-shell/composables/useTabsShellBindings';
import { useWorkspaceRefRegistry } from '@app/modules/workspace-shell/composables/useWorkspaceRefRegistry';
import { useAppUpdates } from '@app/composables/useAppUpdates';
import { useEditorGroupsManager } from '@app/modules/workspace-shell/composables/useEditorGroupsManager';
import { useWorkspaceRestoreTracker } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import { useWindowTabTransfers } from '@app/modules/workspace-shell/composables/useWindowTabTransfers';
import type { TPdfViewMode } from '@contracts/shared';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';

traceRendererStartup('index.vue script setup start');

const {
    groups,
    tabs,
    layout,
    activeGroupId,
    activeTabId,
    ensureAtLeastOneTab,
    getGroupById,
    getTabById,
    getGroupByTabId,
    activateGroup,
    activateTab,
    createTab,
    closeTab,
    moveTabWithinGroup,
    splitGroup,
    closeGroup,
    setSplitRatio,
    focusGroup,
    findDirectionalGroup,
    moveTabToGroup,
} = useEditorGroupsManager();

const { t } = useTypedI18n();
const showSettings = ref(false);
const chromeHostsReady = ref(false);
const workspaceSplitCache = useWorkspaceSplitCache();
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
const hasTeleportedToolbarContentState = shallowRef(false);
const {
    isTabTransitionBusy,
    enqueueTabTransition,
    setAfterTransitionHook,
    updateTab,
    removeTabFromState,
    cleanupEmptyGroups,
    isSingletonPlaceholderCloseBlocked,
    resolveTabForAction,
    closeTabInState,
    handoffActiveTabBeforeClose,
    handleCloseTab,
} = useAppShellTabLifecycle({
    groups,
    tabs,
    activeGroupId,
    activeTabId,
    workspaceRefs,
    hasTeleportedToolbarContent: hasTeleportedToolbarContentState,
    workspaceSplitCache,
    workspaceRestoreTracker,
    getGroupById,
    getTabById,
    getGroupByTabId: (tabId) => (tabId ? getGroupByTabId(tabId) : null),
    activateGroup,
    activateTab,
    closeTab,
    closeGroup,
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

const {
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
    activeGroupId,
    activeTabId,
    activeWorkspace,
    hasTeleportedToolbarContent,
    isTabTransitionBusy,
    getTabById,
});

function handleFallbackOverflowSetViewMode(mode: TPdfViewMode) {
    handleFallbackOverflowSetViewModeInternal(mode, runFallbackWorkspaceAction);
}

useMenuSync({
    activeWorkspace,
    activeTabId,
    tabs,
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
    t: (key, params) => (params ? t(key as never, params as never) : t(key as never)),
});

const {
    captureWorkspacePayload,
    restoreWorkspacePayload,
    handleIncomingTabTransfer,
    moveTabToNewWindow,
    moveTabToWindow,
    mergeWindowInto,
} = useWindowTabTransfers({
    activeGroupId,
    groups,
    tabs,
    layout,
    createTab,
    getGroupById,
    getTabById,
    getGroupByTabId,
    activateGroup,
    activateTab,
    removeTabFromState,
    cleanupEmptyGroups,
    closeTabInState,
    workspaceRefs,
    waitForWorkspace,
    workspaceRestoreTracker,
    t: (key) => t(key as never),
    handleCloseTab,
    handoffActiveTabBeforeClose,
});
const {
    createTabInGroup: createTabInGroupFromRouting,
    handleFallbackToolbarOpenFile,
    handleOpenInNewTab,
    openPathInAppropriateTab,
    openPathsInAppropriateTab,
    handleWindowTabsAction,
} = useAppShellWorkspaceRouting({
    activeGroupId,
    activeTabId,
    activeWorkspace,
    workspaceRefs,
    waitForWorkspace,
    createTab,
    removeTabFromState,
    resolveTabForAction,
    handleCloseTab,
    moveTabToNewWindow,
    moveTabToWindow,
    mergeWindowInto,
});
function createTabInGroup(groupId: string) {
    createTabInGroupFromRouting(groupId);
}
const {
    tabContextAvailabilityByGroup,
    splitEditor,
    focusEditorGroup,
    moveActiveTab,
    copyActiveTab,
    handleTabContextCommand,
    handleTabMoveDirection,
    cleanup: cleanupDirectionalTabs,
} = useAppShellDirectionalTabs({
    activeGroupId,
    groups,
    tabs,
    workspaceRefs,
    isTabTransitionBusy,
    getGroupById,
    getTabById,
    findDirectionalGroup,
    focusGroup,
    splitGroup,
    moveTabToGroup,
    createTab,
    activateGroup,
    activateTab,
    removeTabFromState,
    cleanupEmptyGroups,
    workspaceSplitCache,
    isSingletonPlaceholderCloseBlocked,
    enqueueTabTransition,
    captureWorkspacePayload,
    restoreWorkspacePayload,
    moveTabToNewWindow,
    moveTabToWindow,
    handleCloseTab,
});

const { cleanup: cleanupExternalFileDrop } = useExternalFileDrop({ openPathInAppropriateTab });

const {
    loadRecentFiles,
    clearRecentFiles,
} = useRecentFiles();

useTabsShellBindings({
    tabs,
    activeTabId,
    activeWorkspace,
    createTab: () => createTab({ activate: true }),
    activateTab: (tabId) => {
        const group = getGroupByTabId(tabId);
        if (group) {
            activateTab(group.id, tabId);
        }
    },
    handleCloseTab: async (tabId) => {
        const group = getGroupByTabId(tabId);
        if (!group) {
            return;
        }
        await handleCloseTab(group.id, tabId);
    },
    openPathInAppropriateTab,
    openPathsInAppropriateTab,
    clearRecentFiles,
    loadRecentFiles,
    ensureAtLeastOneTab,
    openSettings: () => {
        showSettings.value = true;
    },
    checkForUpdates,
    splitEditor,
    focusGroup: focusEditorGroup,
    moveActiveTab,
    copyActiveTab,
    handleWindowTabsAction,
});

traceRendererStartup('index.vue setup wiring complete');
useAppShellLifecycle({
    chromeHostsReady,
    dirtyTabCloseDialogOpen,
    updatesDialogOpen: computed(() => updatesDialog.value.open),
    observeToolbarHost,
    cleanupEmptyGroups,
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
.editor-global-toolbar-shell,
.editor-global-toolbar-host,
.editor-global-status-host {
    display: flex;
    flex-direction: column;
    min-height: 0;
}
</style>
