<template>
    <div class="app-shell-root h-screen min-w-0 flex flex-col bg-[var(--app-window-bg)]">
        <div v-if="showBrowserInstallHint" class="browser-install-hint">
            <UIcon name="i-lucide-monitor-down" class="browser-install-icon" />
            <a
                :href="browserInstallUrl"
                target="_blank"
                rel="noreferrer"
                class="browser-install-link"
                @click="handleBrowserInstallHintClick"
            >
                {{ t('webApp.installDesktop') }}
                <UIcon name="i-lucide-arrow-up-right" class="browser-install-link-icon" />
            </a>
            <span class="browser-install-divider" />
            <button
                type="button"
                class="browser-install-dismiss"
                :aria-label="t('webApp.dismissInstallDesktop')"
                @click="dismissBrowserInstallHint('manual')"
            >
                <UIcon name="i-lucide-x" class="browser-install-dismiss-icon" />
            </button>
        </div>

        <div class="editor-global-toolbar-shell">
            <FallbackWorkspaceToolbar
                v-show="showFallbackToolbar"
                :snapshot="fallbackToolbarSnapshot"
                :has-pdf="fallbackHasPdf"
                :ocr-popup-open="fallbackOcrPopupOpen"
                :zoom-dropdown-open="fallbackZoomDropdownOpen"
                :page-dropdown-open="fallbackPageDropdownOpen"
                :overflow-menu-open="fallbackOverflowMenuOpen"
                :app-menu-open="fallbackAppMenuOpen"
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
                @open-settings="showSettings = true"
                @save="runFallbackWorkspaceAction((workspace) => workspace.handleSave())"
                @save-as="runFallbackWorkspaceAction((workspace) => workspace.handleSaveAs())"
                @print="runFallbackWorkspaceAction((workspace) => workspace.handlePrint())"
                @combine-images="runFallbackWorkspaceAction((workspace) => workspace.handleCombineImages())"
                @export-docx="runFallbackWorkspaceAction((workspace) => workspace.handleExportDocx())"
                @export-images="runFallbackWorkspaceAction((workspace) => workspace.handleExportImages())"
                @export-multi-page-tiff="runFallbackWorkspaceAction((workspace) => workspace.handleExportMultiPageTiff())"
                @convert-to-pdf="runFallbackWorkspaceAction((workspace) => workspace.handleConvertToPdf())"
                @undo="runFallbackWorkspaceAction((workspace) => workspace.handleUndo())"
                @redo="runFallbackWorkspaceAction((workspace) => workspace.handleRedo())"
                @insert-image-from-file="runFallbackWorkspaceAction((workspace) => workspace.handleInsertImageFromFile())"
                @paste-image-from-clipboard="runFallbackWorkspaceAction((workspace) => workspace.handlePasteImageFromClipboard())"
                @delete-pages="runFallbackWorkspaceAction((workspace) => workspace.handleDeletePages())"
                @extract-pages="runFallbackWorkspaceAction((workspace) => workspace.handleExtractPages())"
                @rotate-cw="runFallbackWorkspaceAction((workspace) => workspace.handleRotateCw())"
                @rotate-ccw="runFallbackWorkspaceAction((workspace) => workspace.handleRotateCcw())"
                @insert-pages="runFallbackWorkspaceAction((workspace) => workspace.handleInsertPages())"
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
import { BROWSER_INSTALL_HINT_COOKIE_KEY } from '@app/utils/browser-runtime-persistence';
import { resolveAppWindowTitle } from '@app/utils/app-window-title';
import { traceRendererStartup } from '@app/utils/startup-trace';
import { syncBrowserWindowTitle } from '@app/platform/browser-window-tabs';
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
import { useMenuSync } from '@app/modules/workspace-shell/composables/useMenuSync';
import { useWorkspaceShellState } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import { useToolbarTeleportBridge } from '@app/modules/workspace-shell/composables/useToolbarTeleportBridge';
import { useTabsShellBindings } from '@app/modules/workspace-shell/composables/useTabsShellBindings';
import { useWorkspaceRefRegistry } from '@app/modules/workspace-shell/composables/useWorkspaceRefRegistry';
import { useAppUpdates } from '@app/composables/useAppUpdates';
import { useAnalytics } from '@app/composables/useAnalytics';
import { useRuntimeEnvironment } from '@app/composables/useRuntimeEnvironment';
import { useEditorGroupsManager } from '@app/modules/workspace-shell/composables/useEditorGroupsManager';
import { useWorkspaceRestoreTracker } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import { useWindowTabTransfers } from '@app/modules/workspace-shell/composables/useWindowTabTransfers';
import type { TPdfViewMode } from '@contracts/shared';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import { getPlatformAPI } from '@app/utils/platform';

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
const analytics = useAnalytics();
const showSettings = ref(false);
const { isBrowserRuntime } = useRuntimeEnvironment();
const runtimeConfig = useRuntimeConfig();
const browserInstallHintCookie = useCookie<string | null>(
    BROWSER_INSTALL_HINT_COOKIE_KEY,
    {
        default: () => null,
        maxAge: 365 * 24 * 60 * 60,
    },
);
const browserInstallHintDismissed = useState(
    'browser-install-hint:dismissed',
    () => browserInstallHintCookie.value !== null,
);
const didTrackViewerSession = useState(
    'analytics:viewer-session-started',
    () => false,
);
const didTrackInstallHintShown = useState(
    'analytics:install-hint-shown',
    () => false,
);
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
    activeGroupId,
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
    getTabById,
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
    splitEditorEmpty,
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

const { cleanup: cleanupExternalFileDrop } = useExternalFileDrop({ openPathsInAppropriateTab });

const {
    loadRecentFiles,
    clearRecentFiles,
} = useRecentFiles();
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

    browserInstallHintDismissed.value = true;
    trackBrowserInstallHint(reason === 'auto' ? 'auto_dismissed' : 'dismissed');

    if (!import.meta.client || !isBrowserRuntime.value) {
        return;
    }

    browserInstallHintCookie.value = '1';
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

    guardAsync(getPlatformAPI().documents.setWindowTitle(nextTitle), {
        scope: 'window-title',
        message: 'Failed to sync window title',
    });
}, { immediate: true });

const BROWSER_INSTALL_HINT_AUTO_DISMISS_MS = 60_000;

onMounted(() => {
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

    const timer = window.setTimeout(() => dismissBrowserInstallHint('auto'), BROWSER_INSTALL_HINT_AUTO_DISMISS_MS);
    onScopeDispose(() => window.clearTimeout(timer));
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
    handleFallbackToolbarOpenFile,
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
    splitEditorEmpty,
    focusGroup: focusEditorGroup,
    moveActiveTab,
    copyActiveTab,
    handleWindowTabsAction,
});

traceRendererStartup('index.vue setup wiring complete');
useAppShellLifecycle({
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
.app-shell-root {
    position: relative;
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
    border: 1px solid color-mix(in oklab, var(--ui-primary) 18%, var(--ui-border) 82%);
    border-radius: 999px;
    background: color-mix(in oklab, var(--ui-bg) 90%, var(--ui-primary) 10%);
    box-shadow:
        0 1px 3px color-mix(in srgb, var(--ui-border) 14%, transparent),
        0 8px 20px color-mix(in srgb, var(--ui-border) 12%, transparent);
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
    min-height: 1.9rem;
}

@media (width <= 900px) {
    .browser-install-hint {
        right: 0.75rem;
        bottom: 0.75rem;
    }
}
</style>
