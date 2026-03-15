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
import { uniq } from 'es-toolkit/array';
import { withTimeout } from 'es-toolkit/promise';
import { BrowserLogger } from '@app/utils/browser-logger';
import { getElectronAPI } from '@app/utils/platform';
import { guardAsync } from '@app/utils/async-guard';
import { traceRendererStartup } from '@app/utils/startup-trace';
import AppUpdatesDialog from '@app/modules/workspace-shell/components/AppUpdatesDialog.vue';
import DirtyTabCloseDialog from '@app/modules/workspace-shell/components/DirtyTabCloseDialog.vue';
import EditorGroupsHost from '@app/modules/workspace-shell/components/EditorGroupsHost.vue';
import FallbackWorkspaceToolbar from '@app/modules/workspace-shell/components/FallbackWorkspaceToolbar.vue';
import { useExternalFileDrop } from '@app/modules/workspace-shell/composables/useExternalFileDrop';
import { useDirtyTabCloseDialog } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';
import {
    useMenuSync,
    workspaceHasPdf,
} from '@app/modules/workspace-shell/composables/useMenuSync';
import { useToolbarTeleportBridge } from '@app/modules/workspace-shell/composables/useToolbarTeleportBridge';
import { useTabsShellBindings } from '@app/modules/workspace-shell/composables/useTabsShellBindings';
import { isWorkspaceExpose } from '@app/modules/workspace-shell/composables/workspace-expose-contract';
import { hasDocumentMountHint } from '@app/modules/workspace-shell/composables/workspace-host-mounting';
import { useAppUpdates } from '@app/composables/useAppUpdates';
import { useEditorGroupsManager } from '@app/modules/workspace-shell/composables/useEditorGroupsManager';
import { useWorkspaceRestoreTracker } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import { useWorkspaceSplitCache } from '@app/modules/workspace-shell/composables/useWorkspaceSplitCache';
import {
    collectMergeTabOrder,
    shouldCloseSourceWindowAfterTransfer,
} from '@app/modules/workspace-shell/composables/window-tab-transfer-orchestration';
import type { TOpenFileResult } from '@contracts/electron-api';
import type { ITab } from '@app/types/tabs';
import type { TGroupDirection } from '@app/types/editor-groups';
import type {
    TFitMode,
    TZoomMode,
    TPdfViewMode,
} from '@contracts/shared';
import type {
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspace-expose';
import type {
    TSplitPayload,
    ITransferredTabState,
    IWindowTabIncomingTransfer,
    TWindowTabTransferTarget,
    TWindowTabsAction, 
} from '@contracts/window-tabs';
import type {
    ITabContextAvailability,
    TDirectionalCommandAvailability,
    TTabContextCommand,
} from '@app/types/tab-context-menu';

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

const workspaceRefs = shallowRef<Map<string, IWorkspaceExpose>>(new Map());
const pendingWorkspaceWaiters = new Map<string, Set<(workspace: IWorkspaceExpose) => void>>();
const WORKSPACE_REF_WAIT_TIMEOUT_MS = 4000;
const TAB_TRANSITION_CACHE_GRACE_MS = 1200;
const DIRECTION_ORDER: TGroupDirection[] = [
    'left',
    'right',
    'up',
    'down',
];
const activeTabTransitions = ref(0);
let tabTransitionQueue: Promise<void> = Promise.resolve();
let incomingTabTransferCleanup: (() => void) | null = null;
const splitCacheCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

const {
    dirtyTabCloseDialogOpen,
    dirtyTabCloseTargetName,
    confirmDirtyTabClose,
    requestDirtyTabCloseConfirmation,
    resolveDirtyTabCloseDialog,
} = useDirtyTabCloseDialog({tabs});

const isTabTransitionBusy = computed(() => activeTabTransitions.value > 0);
const {
    globalToolbarHostRef,
    hasTeleportedToolbarContent,
    syncToolbarTeleportPresence,
    observeToolbarHost,
    disposeToolbarTeleportBridge,
} = useToolbarTeleportBridge(isTabTransitionBusy);
const showFallbackToolbar = computed(() => (
    !hasTeleportedToolbarContent.value
));
const fallbackZoom = ref(1);
const fallbackEffectiveZoom = ref(1);
const fallbackZoomMode = ref<TZoomMode>('fit-width');
const fallbackFitMode = ref<TFitMode>('width');
const fallbackViewMode = ref<TPdfViewMode>('single');
const fallbackCurrentPage = ref(1);
const fallbackTotalPages = ref(0);
const fallbackCanSave = ref(false);
const fallbackCanUndo = ref(false);
const fallbackCanRedo = ref(false);
const fallbackCanExportDocx = ref(false);
const fallbackIsSaving = ref(false);
const fallbackIsSavingAs = ref(false);
const fallbackIsAnySaving = ref(false);
const fallbackIsHistoryBusy = ref(false);
const fallbackIsExportingDocx = ref(false);
const fallbackIsFitWidthActive = ref(false);
const fallbackIsFitHeightActive = ref(false);
const fallbackShowSidebar = ref(false);
const fallbackDragMode = ref(false);
const fallbackContinuousScroll = ref(false);
const fallbackIsDjvuMode = ref(false);
const fallbackIsCapturingRegion = ref(false);
const fallbackIsCropSelecting = ref(false);
const fallbackIsPlacingPageNote = ref(false);
const fallbackOcrPopupOpen = ref(false);
const fallbackZoomDropdownOpen = ref(false);
const fallbackPageDropdownOpen = ref(false);
const fallbackOverflowMenuOpen = ref(false);
const fallbackHasPdfSignal = computed(() => {
    if (workspaceHasPdf(activeWorkspace.value)) {
        return true;
    }

    const tabId = activeTabId.value;
    if (!tabId) {
        return false;
    }

    const tab = getTabById(tabId);
    if (!tab) {
        return false;
    }

    if (fallbackTotalPages.value > 0) {
        return true;
    }

    return hasDocumentMountHint(tab);
});
const fallbackHasPdf = computed(() => fallbackHasPdfSignal.value);
const fallbackToolbarSnapshot = computed<IWorkspaceToolbarSnapshot>(() => ({
    hasPdf: fallbackHasPdf.value,
    canSave: fallbackCanSave.value,
    canUndo: fallbackCanUndo.value,
    canRedo: fallbackCanRedo.value,
    canExportDocx: fallbackCanExportDocx.value,
    isSaving: fallbackIsSaving.value,
    isSavingAs: fallbackIsSavingAs.value,
    isAnySaving: fallbackIsAnySaving.value,
    isHistoryBusy: fallbackIsHistoryBusy.value,
    isExportingDocx: fallbackIsExportingDocx.value,
    isFitWidthActive: fallbackIsFitWidthActive.value,
    isFitHeightActive: fallbackIsFitHeightActive.value,
    showSidebar: fallbackShowSidebar.value,
    dragMode: fallbackDragMode.value,
    continuousScroll: fallbackContinuousScroll.value,
    isDjvuMode: fallbackIsDjvuMode.value,
    isCapturingRegion: fallbackIsCapturingRegion.value,
    isCropSelecting: fallbackIsCropSelecting.value,
    isPlacingPageNote: fallbackIsPlacingPageNote.value,
    zoom: fallbackZoom.value,
    effectiveZoom: fallbackEffectiveZoom.value,
    zoomMode: fallbackZoomMode.value,
    fitMode: fallbackFitMode.value,
    viewMode: fallbackViewMode.value,
    currentPage: fallbackCurrentPage.value,
    totalPages: fallbackTotalPages.value,
}));

function noopFallbackAction() {}

function getPathBaseName(path: string | null | undefined) {
    if (!path) {
        return null;
    }
    const segment = path.split(/[\\/]/).pop() ?? null;
    if (!segment) {
        return null;
    }
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

function createDefaultToolbarSnapshot(): IWorkspaceToolbarSnapshot {
    return {
        hasPdf: false,
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

function applyFallbackToolbarSnapshot(snapshot: IWorkspaceToolbarSnapshot | null | undefined) {
    if (!snapshot) {
        return;
    }

    const normalizedCurrentPage = Math.max(1, Math.floor(snapshot.currentPage));
    const normalizedTotalPages = Math.max(
        normalizedCurrentPage,
        Math.floor(snapshot.totalPages),
    );

    fallbackCanSave.value = snapshot.canSave;
    fallbackCanUndo.value = snapshot.canUndo;
    fallbackCanRedo.value = snapshot.canRedo;
    fallbackCanExportDocx.value = snapshot.canExportDocx;
    fallbackIsSaving.value = snapshot.isSaving;
    fallbackIsSavingAs.value = snapshot.isSavingAs;
    fallbackIsAnySaving.value = snapshot.isAnySaving;
    fallbackIsHistoryBusy.value = snapshot.isHistoryBusy;
    fallbackIsExportingDocx.value = snapshot.isExportingDocx;
    fallbackIsFitWidthActive.value = snapshot.isFitWidthActive;
    fallbackIsFitHeightActive.value = snapshot.isFitHeightActive;
    fallbackShowSidebar.value = snapshot.showSidebar;
    fallbackDragMode.value = snapshot.dragMode;
    fallbackContinuousScroll.value = snapshot.continuousScroll;
    fallbackIsDjvuMode.value = snapshot.isDjvuMode;
    fallbackIsCapturingRegion.value = snapshot.isCapturingRegion;
    fallbackIsCropSelecting.value = snapshot.isCropSelecting;
    fallbackIsPlacingPageNote.value = snapshot.isPlacingPageNote;
    fallbackZoom.value = snapshot.zoom;
    fallbackEffectiveZoom.value = snapshot.effectiveZoom;
    fallbackZoomMode.value = snapshot.zoomMode;
    fallbackFitMode.value = snapshot.fitMode;
    fallbackViewMode.value = snapshot.viewMode;
    fallbackCurrentPage.value = normalizedCurrentPage;
    fallbackTotalPages.value = normalizedTotalPages;
}

function readToolbarSnapshot(workspace: IWorkspaceExpose | null) {
    if (!workspace) {
        return null;
    }

    try {
        return workspace.getToolbarSnapshot();
    } catch (error) {
        BrowserLogger.debug('toolbar-transition', 'Failed to read toolbar snapshot', {
            activeTabId: activeTabId.value,
            activeGroupId: activeGroupId.value,
            error,
        });
        return null;
    }
}

function primeFallbackToolbarFromWorkspace(workspace: IWorkspaceExpose | null) {
    applyFallbackToolbarSnapshot(readToolbarSnapshot(workspace));
}

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

function handleFallbackOverflowSetViewMode(mode: TPdfViewMode) {
    fallbackViewMode.value = mode;
    runFallbackWorkspaceAction((workspace) => {
        if (mode === 'single') {
            workspace.handleViewModeSingle();
            return;
        }
        if (mode === 'facing') {
            workspace.handleViewModeFacing();
            return;
        }
        workspace.handleViewModeFacingFirstSingle();
    });
}

applyFallbackToolbarSnapshot(createDefaultToolbarSnapshot());

function enqueueTabTransition<T>(task: () => Promise<T>): Promise<T> {
    const chained = tabTransitionQueue.then(async () => {
        activeTabTransitions.value += 1;
        try {
            return await task();
        } finally {
            await nextTick();
            activeTabTransitions.value = Math.max(0, activeTabTransitions.value - 1);
            syncToolbarTeleportPresence();
        }
    });

    tabTransitionQueue = chained.then(
        () => undefined,
        () => undefined,
    );

    return chained;
}

function setWorkspaceRef(tabId: string, el: unknown) {
    if (isWorkspaceExpose(el)) {
        if (workspaceRefs.value.get(tabId) === el) {
            return;
        }
        workspaceRefs.value.set(tabId, el);
        const waiters = pendingWorkspaceWaiters.get(tabId);
        if (waiters && waiters.size > 0) {
            pendingWorkspaceWaiters.delete(tabId);
            for (const waiter of waiters) {
                waiter(el);
            }
        }
        triggerRef(workspaceRefs);
        return;
    }

    if (el) {
        BrowserLogger.warn('tabs', 'Ignoring workspace ref with unexpected shape', {
            tabId,
            receivedType: typeof el,
        });
    }
    if (!workspaceRefs.value.has(tabId)) {
        return;
    }
    workspaceRefs.value.delete(tabId);
    triggerRef(workspaceRefs);
}

function updateTab(tabId: string, updates: Partial<ITab>) {
    const tab = getTabById(tabId);
    if (!tab) {
        return;
    }

    const nextTabState: ITab = {
        ...tab,
        ...updates,
    };

    const wasDocumentTab = hasDocumentMountHint(tab);
    const becomesPlaceholder = !hasDocumentMountHint(nextTabState)
        && nextTabState.fileName === null
        && nextTabState.originalPath === null
        && !nextTabState.isDjvu
        && !nextTabState.isDirty;
    const shouldSuppressPlaceholderDowngrade = wasDocumentTab
        && becomesPlaceholder
        && (
            isTabTransitionBusy.value
            || workspaceSplitCache.has(tabId)
            || workspaceRestoreTracker.has(tabId)
            || (activeTabId.value === tabId && !hasTeleportedToolbarContent.value)
        );

    if (shouldSuppressPlaceholderDowngrade) {
        BrowserLogger.warn('toolbar-transition', 'Suppressing transient placeholder tab update during remount handoff', {
            tabId,
            updates,
            activeTabId: activeTabId.value,
            activeGroupId: activeGroupId.value,
            isTabTransitionBusy: isTabTransitionBusy.value,
            hasSplitCache: workspaceSplitCache.has(tabId),
            isRestoreTracked: workspaceRestoreTracker.has(tabId),
            previousTabState: {
                fileName: tab.fileName,
                originalPath: tab.originalPath,
                isDirty: tab.isDirty,
                isDjvu: tab.isDjvu,
            },
            nextTabState: {
                fileName: nextTabState.fileName,
                originalPath: nextTabState.originalPath,
                isDirty: nextTabState.isDirty,
                isDjvu: nextTabState.isDjvu,
            },
        });
        return;
    }

    Object.assign(tab, updates);
}

async function waitForWorkspace(tabId: string, timeoutMs = WORKSPACE_REF_WAIT_TIMEOUT_MS) {
    const existingWorkspace = workspaceRefs.value.get(tabId) ?? null;
    if (existingWorkspace) {
        return existingWorkspace;
    }
    let waiter: ((workspace: IWorkspaceExpose) => void) | null = null;

    const cleanupWaiter = () => {
        if (!waiter) {
            return;
        }
        const activeWaiters = pendingWorkspaceWaiters.get(tabId);
        activeWaiters?.delete(waiter);
        if (activeWaiters && activeWaiters.size === 0) {
            pendingWorkspaceWaiters.delete(tabId);
        }
        waiter = null;
    };

    const waiterPromise = new Promise<IWorkspaceExpose>((resolve) => {
        waiter = (workspace: IWorkspaceExpose) => {
            resolve(workspace);
        };

        const waiters = pendingWorkspaceWaiters.get(tabId);
        if (waiters) {
            waiters.add(waiter);
        } else {
            pendingWorkspaceWaiters.set(tabId, new Set([waiter]));
        }

        const currentWorkspace = workspaceRefs.value.get(tabId) ?? null;
        if (currentWorkspace && waiter) {
            const currentWaiters = pendingWorkspaceWaiters.get(tabId);
            currentWaiters?.delete(waiter);
            if (currentWaiters && currentWaiters.size === 0) {
                pendingWorkspaceWaiters.delete(tabId);
            }
            waiter = null;
            resolve(currentWorkspace);
        }
    });

    try {
        return await withTimeout(() => waiterPromise, timeoutMs);
    } catch {
        BrowserLogger.warn('tabs', 'Workspace did not mount in time', {
            tabId,
            timeoutMs,
        });
        return null;
    } finally {
        cleanupWaiter();
    }
}

function removeTabFromState(tabId: string) {
    const group = getGroupByTabId(tabId);
    if (group) {
        closeTab(group.id, tabId);
    }
    workspaceSplitCache.clear(tabId);
}

function cleanupEmptyGroups() {
    for (const group of [...groups.value]) {
        if (groups.value.length <= 1) {
            break;
        }
        if (group.tabIds.length === 0) {
            closeGroup(group.id);
        }
    }
}

function buildTransferredTabState(tab: ITab): ITransferredTabState {
    return {
        fileName: tab.fileName,
        originalPath: tab.originalPath,
        isDirty: tab.isDirty,
        isDjvu: tab.isDjvu,
    };
}

function isPlaceholderTab(tab: ITab) {
    return tab.fileName === null
        && tab.originalPath === null
        && !tab.isDirty
        && !tab.isDjvu;
}

function isSingletonPlaceholderCloseBlocked(groupId: string, tabId: string) {
    if (tabs.value.length !== 1) {
        return false;
    }

    const group = getGroupById(groupId);
    if (!group || group.tabIds.length !== 1 || !group.tabIds.includes(tabId)) {
        return false;
    }

    const tab = getTabById(tabId);
    if (!tab || !isPlaceholderTab(tab)) {
        return false;
    }

    const workspace = workspaceRefs.value.get(tabId) ?? null;
    return !workspaceHasPdf(workspace);
}

function resolveIncomingTransferTargetTab(
    targetGroupId: string,
): {
    tabId: string;
    created: boolean;
} | null {
    const targetGroup = getGroupById(targetGroupId);
    if (!targetGroup) {
        return null;
    }

    const existingTabId = targetGroup.tabIds[0] ?? null;
    const existingTab = getTabById(existingTabId);
    const existingWorkspace = existingTabId ? workspaceRefs.value.get(existingTabId) ?? null : null;
    const existingHasDocument = workspaceHasPdf(existingWorkspace);

    if (
        existingTab
        && targetGroup.tabIds.length === 1
        && tabs.value.length === 1
        && isPlaceholderTab(existingTab)
        && !existingHasDocument
    ) {
        activateGroup(targetGroup.id);
        activateTab(targetGroup.id, existingTab.id);
        return {
            tabId: existingTab.id,
            created: false,
        };
    }

    const createdTab = createTab({
        groupId: targetGroup.id,
        activate: false,
    });

    return {
        tabId: createdTab.id,
        created: true,
    };
}

function resolveTabForAction(tabId: string | undefined) {
    const resolvedTabId = tabId ?? activeTabId.value ?? undefined;
    if (!resolvedTabId) {
        return null;
    }

    const tab = getTabById(resolvedTabId);
    if (!tab) {
        return null;
    }

    const group = getGroupByTabId(resolvedTabId);
    if (!group) {
        return null;
    }

    return {
        tab,
        group,
    };
}

function scoreTabDocumentReadiness(tabId: string) {
    const workspace = workspaceRefs.value.get(tabId) ?? null;
    if (workspaceHasPdf(workspace)) {
        return 3;
    }

    const tab = getTabById(tabId);
    if (tab && hasDocumentMountHint(tab)) {
        return 2;
    }

    return 1;
}

function pickBestTabCandidate(tabIds: Array<string | null | undefined>) {
    const uniqueTabIds = uniq(tabIds.filter((tabId): tabId is string => Boolean(tabId)));

    let bestTabId: string | null = null;
    let bestScore = -1;
    for (const tabId of uniqueTabIds) {
        if (!getTabById(tabId)) {
            continue;
        }
        const score = scoreTabDocumentReadiness(tabId);
        if (score > bestScore) {
            bestScore = score;
            bestTabId = tabId;
        }
    }

    return bestTabId;
}

function resolveCloseHandoffTarget(groupId: string, tabId: string) {
    if (activeGroupId.value !== groupId || activeTabId.value !== tabId) {
        return null;
    }

    const sourceGroup = getGroupById(groupId);
    if (!sourceGroup) {
        return null;
    }

    const closingTabIndex = sourceGroup.tabIds.indexOf(tabId);
    if (closingTabIndex === -1) {
        return null;
    }

    const sameGroupReplacement = pickBestTabCandidate([
        sourceGroup.tabIds[closingTabIndex + 1],
        sourceGroup.tabIds[closingTabIndex - 1],
        ...sourceGroup.tabIds.filter(candidate => candidate !== tabId),
    ]);
    if (sameGroupReplacement) {
        return {
            groupId: sourceGroup.id,
            tabId: sameGroupReplacement,
        };
    }

    let bestTarget: {
        groupId: string;
        tabId: string;
        score: number;
    } | null = null;

    for (const candidateGroup of groups.value) {
        if (candidateGroup.id === sourceGroup.id || candidateGroup.tabIds.length === 0) {
            continue;
        }

        const candidateTabId = pickBestTabCandidate([
            candidateGroup.activeTabId,
            ...candidateGroup.tabIds,
        ]);
        if (!candidateTabId) {
            continue;
        }

        const score = scoreTabDocumentReadiness(candidateTabId);
        if (!bestTarget || score > bestTarget.score) {
            bestTarget = {
                groupId: candidateGroup.id,
                tabId: candidateTabId,
                score,
            };
        }
    }

    if (!bestTarget) {
        return null;
    }

    return {
        groupId: bestTarget.groupId,
        tabId: bestTarget.tabId,
    };
}

async function handoffActiveTabBeforeClose(groupId: string, tabId: string) {
    const target = resolveCloseHandoffTarget(groupId, tabId);
    if (!target) {
        return;
    }

    activateGroup(target.groupId);
    activateTab(target.groupId, target.tabId);
    await nextTick();
}

const activeWorkspace = computed(() => {
    if (!activeTabId.value) {
        return null;
    }
    return workspaceRefs.value.get(activeTabId.value) ?? null;
});

const activeWindowTitle = computed(() => {
    const activeTab = activeTabId.value ? getTabById(activeTabId.value) : null;
    if (!activeTab) {
        return t('app.title');
    }

    if (activeTab.fileName) {
        return activeTab.fileName;
    }

    const pathTitle = getPathBaseName(activeTab.originalPath);
    if (pathTitle) {
        return pathTitle;
    }

    return t('app.title');
});

watch(activeWindowTitle, (title) => {
    const setWindowTitle = getElectronAPI().documents?.setWindowTitle;
    if (!setWindowTitle) {
        return;
    }
    guardAsync(setWindowTitle(title), {
        scope: 'shell',
        message: 'Failed to sync window title',
    });
}, { immediate: true });

watch(activeWorkspace, (workspace) => {
    primeFallbackToolbarFromWorkspace(workspace);
}, { immediate: true });


watch(
    [
        activeTabId,
        activeWorkspace,
    ],
    () => {
        if (isTabTransitionBusy.value || !hasTeleportedToolbarContent.value) {
            return;
        }

        if (workspaceHasPdf(activeWorkspace.value)) {
            return;
        }

        const tabId = activeTabId.value;
        const tab = tabId ? getTabById(tabId) : null;
        if (tab && hasDocumentMountHint(tab)) {
            return;
        }

        applyFallbackToolbarSnapshot(createDefaultToolbarSnapshot());
    },
    { immediate: true },
);

useMenuSync({
    activeWorkspace,
    activeTabId,
    tabs,
});

function createDirectionalAvailability(value: boolean): TDirectionalCommandAvailability {
    return {
        left: value,
        right: value,
        up: value,
        down: value,
    };
}

function getDirectionalTargetGroup(sourceGroupId: string, direction: TGroupDirection) {
    return findDirectionalGroup(sourceGroupId, direction, false);
}

const tabContextAvailabilityByGroup = computed<Record<string, ITabContextAvailability>>(() => {
    const result: Record<string, ITabContextAvailability> = {};
    const transitionsBusy = isTabTransitionBusy.value;

    for (const group of groups.value) {
        const activeTabIdForGroup = group.activeTabId;
        const hasActiveTab = Boolean(activeTabIdForGroup);
        const closeBlocked = activeTabIdForGroup
            ? isSingletonPlaceholderCloseBlocked(group.id, activeTabIdForGroup)
            : false;
        const focus = createDirectionalAvailability(false);
        const move = createDirectionalAvailability(false);
        const copy = createDirectionalAvailability(false);

        for (const direction of DIRECTION_ORDER) {
            const focusTarget = findDirectionalGroup(group.id, direction, true);
            const directionalTarget = getDirectionalTargetGroup(group.id, direction);
            const hasUsableDirectionalGroup = Boolean(directionalTarget && directionalTarget.tabIds.length > 0);
            focus[direction] = groups.value.length > 1
                ? Boolean(focusTarget && focusTarget.tabIds.length > 0) && !transitionsBusy
                : false;
            move[direction] = hasActiveTab && hasUsableDirectionalGroup && !transitionsBusy;
            copy[direction] = hasActiveTab && hasUsableDirectionalGroup && !transitionsBusy;
        }

        result[group.id] = {
            split: createDirectionalAvailability(hasActiveTab && !transitionsBusy),
            focus,
            move,
            copy,
            canClose: hasActiveTab && !transitionsBusy && !closeBlocked,
            canCreate: !transitionsBusy,
            canMoveToNewWindow: tabs.value.length > 1 && !transitionsBusy,
        };
    }

    return result;
});

const updatesDialogTitle = computed(() => {
    if (updatesDialog.value.kind === 'ready') {
        return t('updates.readyTitle');
    }

    switch (updatesDialog.value.phase) {
        case 'checking':
            return t('updates.checkingTitle');
        case 'downloading':
            return t('updates.downloadingTitle');
        case 'no-update':
            return t('updates.upToDateTitle');
        case 'error':
            return t('updates.errorTitle');
        case 'unsupported':
            return t('updates.unsupportedTitle');
        default:
            return t('updates.checkingTitle');
    }
});

const updatesDialogDescription = computed(() => {
    const version = updatesDialogVersion.value ?? t('updates.unknownVersion');

    if (updatesDialog.value.kind === 'ready') {
        return t('updates.readyDescription', { version });
    }

    switch (updatesDialog.value.phase) {
        case 'checking':
            return t('updates.checkingDescription');
        case 'downloading': {
            const percent = Math.max(0, Math.round(updatesDialog.value.percent ?? 0));
            return t('updates.downloadingDescription', {
                version,
                percent,
            });
        }
        case 'no-update':
            return t('updates.upToDateDescription', { version });
        case 'error':
            return t('updates.errorDescription', { message: updatesDialog.value.message ?? t('updates.unknownError') });
        case 'unsupported':
            return t('updates.unsupportedDescription');
        default:
            return t('updates.checkingDescription');
    }
});

function handleDeferUpdate() {
    closeUpdatesDialog();
    void deferUpdate();
}

function handleSkipUpdate() {
    closeUpdatesDialog();
    void skipUpdateVersion();
}

function handleInstallUpdate() {
    void installUpdateNow();
}

async function handleCloseTab(groupId: string, tabId: string) {
    if (isSingletonPlaceholderCloseBlocked(groupId, tabId)) {
        return;
    }

    await enqueueTabTransition(async () => {
        const tab = getTabById(tabId);
        if (!tab) {
            return;
        }

        const sourceGroupBeforeClose = getGroupById(groupId);
        const closeHandoffTarget = resolveCloseHandoffTarget(groupId, tabId);
        const shouldDeferCrossGroupHandoff = Boolean(
            sourceGroupBeforeClose
            && closeHandoffTarget
            && sourceGroupBeforeClose.tabIds.length === 1
            && closeHandoffTarget.groupId !== sourceGroupBeforeClose.id,
        );

        const activateDeferredCloseHandoff = async () => {
            if (!shouldDeferCrossGroupHandoff || !closeHandoffTarget) {
                return;
            }

            const targetTab = getTabById(closeHandoffTarget.tabId);
            const targetGroup = getGroupById(closeHandoffTarget.groupId)
                ?? getGroupByTabId(closeHandoffTarget.tabId);
            if (!targetTab || !targetGroup || !targetGroup.tabIds.includes(targetTab.id)) {
                return;
            }

            activateGroup(targetGroup.id);
            activateTab(targetGroup.id, targetTab.id);
            await nextTick();
        };

        let shouldPersistBeforeClose = true;
        if (tab.isDirty) {
            const confirmed = await requestDirtyTabCloseConfirmation(tabId);
            if (!confirmed) {
                return;
            }
            shouldPersistBeforeClose = false;
        }

        if (!shouldDeferCrossGroupHandoff) {
            await handoffActiveTabBeforeClose(groupId, tabId);
        }

        const workspace = workspaceRefs.value.get(tabId);
        if (workspace && workspaceHasPdf(workspace)) {
            workspaceRestoreTracker.start(tabId);
            try {
                await workspace.handleCloseFileFromUi({ persist: shouldPersistBeforeClose });
            } finally {
                workspaceRestoreTracker.finish(tabId);
            }

            if (!workspaceHasPdf(workspace)) {
                const resolvedGroup = getGroupByTabId(tabId) ?? getGroupById(groupId);
                if (resolvedGroup) {
                    closeTabInState(resolvedGroup.id, tabId);
                }
            }
            cleanupEmptyGroups();
            await activateDeferredCloseHandoff();
            return;
        }

        const resolvedGroup = getGroupByTabId(tabId) ?? getGroupById(groupId);
        if (resolvedGroup) {
            closeTabInState(resolvedGroup.id, tabId);
        }

        cleanupEmptyGroups();
        await activateDeferredCloseHandoff();
    });
}

function scheduleSplitCacheCleanup(tabId: string) {
    const previousTimer = splitCacheCleanupTimers.get(tabId);
    if (previousTimer) {
        clearTimeout(previousTimer);
    }

    const timer = setTimeout(() => {
        splitCacheCleanupTimers.delete(tabId);
        const workspace = workspaceRefs.value.get(tabId);
        if (workspace && workspaceHasPdf(workspace)) {
            workspaceSplitCache.clear(tabId);
        }
    }, TAB_TRANSITION_CACHE_GRACE_MS);
    timer.unref?.();
    splitCacheCleanupTimers.set(tabId, timer);
}

function createTabInGroup(groupId: string) {
    createTab({
        groupId,
        activate: true,
    });
}

async function handleFallbackToolbarOpenFile() {
    const currentActiveTabId = activeTabId.value;
    const workspace = activeWorkspace.value
        ?? (currentActiveTabId
            ? (workspaceRefs.value.get(currentActiveTabId) ?? await waitForWorkspace(currentActiveTabId))
            : null);

    if (workspace) {
        await workspace.handleOpenFileFromUi();
        return;
    }

    const fallbackTab = createTab({
        groupId: activeGroupId.value,
        activate: true,
    });
    const fallbackWorkspace = await waitForWorkspace(fallbackTab.id);
    if (!fallbackWorkspace) {
        removeTabFromState(fallbackTab.id);
        return;
    }
    await fallbackWorkspace.handleOpenFileFromUi();
}

async function handleOpenInNewTab(pathOrResult: string | TOpenFileResult, groupId?: string) {
    const targetGroupId = groupId ?? activeGroupId.value ?? undefined;
    const tab = createTab({
        groupId: targetGroupId,
        activate: true,
    });
    const ws = await waitForWorkspace(tab.id);
    if (!ws) {
        removeTabFromState(tab.id);
        return;
    }
    if (typeof pathOrResult === 'string') {
        await ws.handleOpenFileDirectWithPersist(pathOrResult);
    } else {
        await ws.handleOpenFileWithResult(pathOrResult);
    }
}

async function openPathInAppropriateTab(path: string) {
    const activeTabWorkspace = activeTabId.value
        ? (workspaceRefs.value.get(activeTabId.value) ?? await waitForWorkspace(activeTabId.value))
        : null;
    const ws = activeWorkspace.value ?? activeTabWorkspace;
    if (ws && !workspaceHasPdf(ws)) {
        await ws.handleOpenFileDirectWithPersist(path);
        return;
    }
    await handleOpenInNewTab(path, activeGroupId.value ?? undefined);
}

async function openPathsInAppropriateTab(paths: string[]) {
    const normalizedPaths = paths
        .map(path => path.trim())
        .filter(path => path.length > 0);
    if (normalizedPaths.length === 0) {
        return;
    }

    if (normalizedPaths.length === 1) {
        await openPathInAppropriateTab(normalizedPaths[0]!);
        return;
    }

    const activeTabWorkspace = activeTabId.value
        ? (workspaceRefs.value.get(activeTabId.value) ?? await waitForWorkspace(activeTabId.value))
        : null;
    let ws = activeWorkspace.value ?? activeTabWorkspace;
    if (!ws || workspaceHasPdf(ws)) {
        const tab = createTab({
            groupId: activeGroupId.value,
            activate: true,
        });
        ws = await waitForWorkspace(tab.id);
        if (!ws) {
            removeTabFromState(tab.id);
            return;
        }
    }

    await ws.handleOpenFileDirectBatchWithPersist(normalizedPaths);
}

async function captureWorkspacePayload(
    tabId: string,
    timeoutMs = WORKSPACE_REF_WAIT_TIMEOUT_MS,
): Promise<TSplitPayload | null> {
    const workspace = await waitForWorkspace(tabId, timeoutMs);
    if (!workspace) {
        return null;
    }

    try {
        return await workspace.captureSplitPayload();
    } catch (error) {
        BrowserLogger.error('tabs', 'Failed to capture split payload', {
            tabId,
            error,
        });
        return null;
    }
}

async function restoreWorkspacePayload(tabId: string, payload: TSplitPayload | null) {
    if (!payload) {
        return false;
    }

    workspaceRestoreTracker.start(tabId);
    try {
        const workspace = await waitForWorkspace(tabId);
        if (!workspace) {
            return false;
        }
        await workspace.restoreSplitPayload(payload);
        await nextTick();

        // PDF snapshot payloads must result in an opened PDF.
        if (payload.kind === 'pdfSnapshot' && !workspaceHasPdf(workspace)) {
            BrowserLogger.warn('tabs', 'Split payload restore finished without an opened document', {
                tabId,
                payloadKind: payload.kind,
            });
            return false;
        }

        return true;
    } catch (error) {
        BrowserLogger.error('tabs', 'Failed to restore split payload', {
            tabId,
            payloadKind: payload.kind,
            error,
        });
        return false;
    } finally {
        workspaceRestoreTracker.finish(tabId);
    }
}

type TSourceTransferOutcome = 'success' | 'failed' | 'window-closed';

async function closeSourceWorkspaceWithoutPersist(groupId: string, tabId: string) {
    await handoffActiveTabBeforeClose(groupId, tabId);

    const workspace = workspaceRefs.value.get(tabId);
    if (!workspace || !workspaceHasPdf(workspace)) {
        return true;
    }

    workspaceRestoreTracker.start(tabId);
    try {
        await workspace.handleCloseFileFromUi({persist: false});
        return true;
    } catch (error) {
        BrowserLogger.error('tabs', 'Failed to close source workspace after transfer', {
            tabId,
            error,
        });
        return false;
    } finally {
        workspaceRestoreTracker.finish(tabId);
    }
}

async function finalizeTransferredSourceTab(groupId: string, tabId: string): Promise<TSourceTransferOutcome> {
    const sourceCloseSucceeded = await closeSourceWorkspaceWithoutPersist(groupId, tabId);
    if (!sourceCloseSucceeded) {
        return 'failed';
    }

    if (shouldCloseSourceWindowAfterTransfer(tabs.value.length, true)) {
        const closed = await getElectronAPI().windowTabs.closeCurrentWindow();
        if (closed) {
            return 'window-closed';
        }
    }

    closeTabInState(groupId, tabId);
    cleanupEmptyGroups();
    return 'success';
}

async function transferTabToTarget(tabId: string, target: TWindowTabTransferTarget): Promise<TSourceTransferOutcome> {
    const tab = getTabById(tabId);
    const sourceGroup = getGroupByTabId(tabId);
    if (!tab || !sourceGroup) {
        return 'failed';
    }

    const payload = await captureWorkspacePayload(tab.id);
    if (!payload) {
        return 'failed';
    }

    const transferResult = await getElectronAPI().windowTabs.transfer({
        target,
        tab: buildTransferredTabState(tab),
        payload,
    });

    if (!transferResult.success) {
        BrowserLogger.warn('tabs', 'Cross-window transfer failed', {
            tabId,
            target,
            error: transferResult.error,
        });
        return 'failed';
    }

    return finalizeTransferredSourceTab(sourceGroup.id, tab.id);
}

async function moveTabToNewWindow(tabId?: string) {
    const resolved = resolveTabForAction(tabId);
    if (!resolved) {
        return;
    }

    await transferTabToTarget(resolved.tab.id, {kind: 'new-window'});
}

async function moveTabToWindow(targetWindowId: number, tabId?: string) {
    const resolved = resolveTabForAction(tabId);
    if (!resolved) {
        return;
    }

    await transferTabToTarget(resolved.tab.id, {
        kind: 'window',
        windowId: targetWindowId,
    });
}

async function mergeWindowInto(targetWindowId: number) {
    const orderedTabIds = collectMergeTabOrder(layout.value, groups.value, tabs.value);
    for (const tabId of orderedTabIds) {
        if (!getTabById(tabId)) {
            continue;
        }

        const result = await transferTabToTarget(tabId, {
            kind: 'window',
            windowId: targetWindowId,
        });

        if (result === 'failed' || result === 'window-closed') {
            return;
        }
    }
}

async function handleIncomingTabTransfer(transfer: IWindowTabIncomingTransfer) {
    const ackFailure = async (error: string) => {
        await getElectronAPI().windowTabs.transferAck({
            transferId: transfer.transferId,
            success: false,
            error,
        });
    };

    try {
        const targetGroup = getGroupById(activeGroupId.value) ?? groups.value[0] ?? null;
        if (!targetGroup) {
            await ackFailure(t('tabs.transferErrors.noTargetGroup'));
            return;
        }

        const targetTab = resolveIncomingTransferTargetTab(targetGroup.id);
        if (!targetTab) {
            await ackFailure(t('tabs.transferErrors.noTargetTab'));
            return;
        }

        const restored = await restoreWorkspacePayload(targetTab.tabId, transfer.payload);
        if (!restored) {
            if (targetTab.created) {
                removeTabFromState(targetTab.tabId);
            }
            await ackFailure(t('tabs.transferErrors.restoreFailed'));
            return;
        }

        updateTab(targetTab.tabId, transfer.tab);
        activateGroup(targetGroup.id);
        activateTab(targetGroup.id, targetTab.tabId);

        await getElectronAPI().windowTabs.transferAck({
            transferId: transfer.transferId,
            success: true,
        });
    } catch (error) {
        BrowserLogger.error('tabs', 'Unhandled incoming tab transfer failure', {
            transferId: transfer.transferId,
            error,
        });

        await getElectronAPI().windowTabs.transferAck({
            transferId: transfer.transferId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

async function handleWindowTabsAction(action: TWindowTabsAction) {
    if (action.kind === 'close-tab') {
        const resolved = resolveTabForAction(action.tabId);
        if (!resolved) {
            return;
        }
        await handleCloseTab(resolved.group.id, resolved.tab.id);
        return;
    }

    if (action.kind === 'move-tab-to-new-window') {
        await moveTabToNewWindow(action.tabId);
        return;
    }

    if (action.kind === 'move-tab-to-window') {
        await moveTabToWindow(action.targetWindowId, action.tabId);
        return;
    }

    await mergeWindowInto(action.targetWindowId);
}

function closeTabInState(groupId: string, tabId: string) {
    closeTab(groupId, tabId);
    workspaceSplitCache.clear(tabId);
}

async function splitEditor(direction: TGroupDirection) {
    await enqueueTabTransition(async () => {
        const sourceGroup = getGroupById(activeGroupId.value);
        const sourceTabId = sourceGroup?.activeTabId ?? null;
        const sourceTab = getTabById(sourceTabId);
        if (!sourceGroup || !sourceTabId || !sourceTab) {
            return;
        }

        const payload = await captureWorkspacePayload(sourceTabId);
        if (!payload) {
            return;
        }

        workspaceSplitCache.set(sourceTabId, payload);
        scheduleSplitCacheCleanup(sourceTabId);

        const newGroupId = splitGroup(sourceGroup.id, direction);
        if (!newGroupId) {
            return;
        }

        const newTab = createTab({
            groupId: newGroupId,
            activate: false,
            initial: {
                fileName: sourceTab.fileName,
                originalPath: sourceTab.originalPath,
                isDirty: sourceTab.isDirty,
                isDjvu: sourceTab.isDjvu,
            },
        });

        const restored = await restoreWorkspacePayload(newTab.id, payload);
        if (!restored) {
            removeTabFromState(newTab.id);
            activateTab(sourceGroup.id, sourceTabId);
            return;
        }

        activateGroup(sourceGroup.id);
        activateTab(sourceGroup.id, sourceTabId);
        cleanupEmptyGroups();
    });
}

function focusEditorGroup(direction: TGroupDirection) {
    if (isTabTransitionBusy.value) {
        return;
    }
    focusGroup(direction, true);
}

function ensureTargetGroupForDirection(direction: TGroupDirection) {
    const sourceGroup = getGroupById(activeGroupId.value);
    if (!sourceGroup) {
        return null;
    }

    const existing = getDirectionalTargetGroup(sourceGroup.id, direction);
    if (!existing || existing.tabIds.length === 0) {
        return null;
    }

    return {
        sourceGroup,
        targetGroupId: existing.id,
    };
}

async function moveActiveTab(direction: TGroupDirection) {
    await enqueueTabTransition(async () => {
        const sourceGroup = getGroupById(activeGroupId.value);
        const sourceTabId = sourceGroup?.activeTabId ?? null;
        if (!sourceGroup || !sourceTabId) {
            return;
        }

        const route = ensureTargetGroupForDirection(direction);
        if (!route) {
            return;
        }

        const payload = await captureWorkspacePayload(sourceTabId);
        if (!payload) {
            return;
        }

        if (payload.kind !== 'empty') {
            workspaceSplitCache.set(sourceTabId, payload);
            scheduleSplitCacheCleanup(sourceTabId);
        }

        const moved = moveTabToGroup(sourceTabId, route.targetGroupId, true);
        if (moved) {
            activateTab(route.targetGroupId, sourceTabId);
        }
        cleanupEmptyGroups();
    });
}

async function copyActiveTab(direction: TGroupDirection) {
    await enqueueTabTransition(async () => {
        const sourceGroup = getGroupById(activeGroupId.value);
        const sourceTabId = sourceGroup?.activeTabId ?? null;
        const sourceTab = getTabById(sourceTabId);
        if (!sourceGroup || !sourceTabId || !sourceTab) {
            return;
        }

        const payload = await captureWorkspacePayload(sourceTabId);
        if (!payload) {
            return;
        }

        const route = ensureTargetGroupForDirection(direction);
        if (!route) {
            return;
        }

        const targetTab = createTab({
            groupId: route.targetGroupId,
            activate: false,
            initial: {
                fileName: sourceTab.fileName,
                originalPath: sourceTab.originalPath,
                isDirty: sourceTab.isDirty,
                isDjvu: sourceTab.isDjvu,
            },
        });

        const restored = await restoreWorkspacePayload(targetTab.id, payload);
        if (!restored) {
            removeTabFromState(targetTab.id);
            activateTab(sourceGroup.id, sourceTabId);
            return;
        }

        activateTab(route.targetGroupId, targetTab.id);
        cleanupEmptyGroups();
    });
}

async function handleTabContextCommand(
    groupId: string,
    tabId: string,
    command: TTabContextCommand,
) {
    const group = getGroupById(groupId);
    if (!group) {
        return;
    }

    activateGroup(groupId);
    activateTab(groupId, tabId);

    if (command.kind === 'new-tab') {
        createTabInGroup(groupId);
        return;
    }

    if (command.kind === 'close-tab') {
        await handleCloseTab(groupId, tabId);
        return;
    }

    if (command.kind === 'move-to-new-window') {
        await moveTabToNewWindow(tabId);
        return;
    }

    if (command.kind === 'move-to-window') {
        await moveTabToWindow(command.targetWindowId, tabId);
        return;
    }

    if (command.kind === 'split') {
        await splitEditor(command.direction);
        return;
    }

    if (command.kind === 'focus') {
        focusEditorGroup(command.direction);
        return;
    }

    if (command.kind === 'move') {
        await moveActiveTab(command.direction);
        return;
    }

    await copyActiveTab(command.direction);
}

function handleTabMoveDirection(
    groupId: string,
    tabId: string,
    direction: 'left' | 'right',
) {
    const group = getGroupById(groupId);
    if (!group || !group.tabIds.includes(tabId)) {
        return;
    }

    activateGroup(groupId);
    activateTab(groupId, tabId);
    void moveActiveTab(direction);
}

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

onMounted(() => {
    const start = performance.now();
    traceRendererStartup('index.vue onMounted start');

    observeToolbarHost();

    chromeHostsReady.value = true;
    traceRendererStartup('index.vue chrome hosts marked ready');
    cleanupEmptyGroups();
    void ensureUpdatesInitialized();

    incomingTabTransferCleanup = getElectronAPI().windowTabs.onIncomingTransfer((transfer) => {
        void handleIncomingTabTransfer(transfer);
    });
    traceRendererStartup('index.vue onMounted finished', {durationMs: Math.round(performance.now() - start)});
});

onUnmounted(() => {
    for (const timer of splitCacheCleanupTimers.values()) {
        clearTimeout(timer);
    }
    splitCacheCleanupTimers.clear();
    disposeToolbarTeleportBridge();
    incomingTabTransferCleanup?.();
    incomingTabTransferCleanup = null;
    cleanupExternalFileDrop();
});

watch(dirtyTabCloseDialogOpen, (isOpen) => {
    if (!isOpen) {
        resolveDirtyTabCloseDialog(false);
    }
});

watch(() => updatesDialog.value.open, (isOpen) => {
    if (!isOpen) {
        closeUpdatesDialog();
    }
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
