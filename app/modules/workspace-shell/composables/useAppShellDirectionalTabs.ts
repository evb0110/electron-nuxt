import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TSplitPayload } from '@contracts/windowTabs';
import { workspaceHasPdf } from '@app/modules/workspace-shell/state/workspaceHasPdf';
import { cleanupSplitPayloadSnapshot } from '@app/modules/workspace-shell/splits/cleanupSplitPayloadSnapshot';
import type {
    IEditorPaneState,
    TPaneDirection,
} from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type {
    ITabContextAvailability,
    TDirectionalCommandAvailability,
    TDirectionalTabContextCommand,
    TTabContextCommand,
} from '@app/types/tabContextMenu';
import { hasElectronAPI } from '@app/utils/platform';
import { isBrowserDocumentRef } from '@app/utils/documentRef';
import {
    getDocumentWindowCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import type { IWorkspaceSplitCacheLike } from '@app/modules/workspace-shell/composables/workspaceSplitTypes';

const TAB_TRANSITION_CACHE_GRACE_MS = 1200;
const DIRECTION_ORDER = [
    'left',
    'right',
    'up',
    'down',
] as const satisfies readonly TPaneDirection[];

interface IUseAppShellDirectionalTabsOptions {
    activePaneId: Ref<string | null>;
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    isTabTransitionBusy: ComputedRef<boolean>;
    getPaneById: (paneId: string | null | undefined) => IEditorPaneState | null;
    getTabById: (tabId: string | null | undefined) => ITab | null;
    findDirectionalPane: (sourcePaneId: string, direction: TPaneDirection, wrap?: boolean) => IEditorPaneState | null;
    focusPane: (direction: TPaneDirection, wrap?: boolean) => string | null;
    splitPane: (sourcePaneId: string, direction: TPaneDirection) => string | null;
    moveTabToPane: (tabId: string, targetPaneId: string, activate?: boolean) => boolean;
    createTab: (options: {
        paneId?: string | null;
        activate?: boolean;
        initial?: Partial<ITab>;
    }) => ITab;
    activatePane: (paneId: string) => void;
    activateTab: (paneId: string, tabId: string) => void;
    removeTabFromState: (tabId: string) => void;
    cleanupEmptyPanes: () => void;
    workspaceSplitCache: IWorkspaceSplitCacheLike;
    isSingletonPlaceholderCloseBlocked: (paneId: string, tabId: string) => boolean;
    enqueueTabTransition: <T>(task: () => Promise<T>) => Promise<T>;
    captureWorkspacePayload: (tabId: string) => Promise<TSplitPayload | null>;
    restoreWorkspacePayload: (tabId: string, payload: TSplitPayload | null) => Promise<boolean>;
    moveTabToNewWindow: (tabId: string) => Promise<void>;
    moveTabToWindow: (windowId: number, tabId: string) => Promise<void>;
    handleCloseTab: (paneId: string, tabId: string) => Promise<void>;
}

type TStaticTabContextCommand = Exclude<TTabContextCommand, TDirectionalTabContextCommand>;
type TStaticTabContextCommandWithoutTargetWindow = Exclude<TStaticTabContextCommand, { kind: 'move-to-window' }>;

function createDirectionalAvailability(value: boolean): TDirectionalCommandAvailability {
    return {
        left: value,
        right: value,
        up: value,
        down: value,
    };
}

function hasTabs(pane: IEditorPaneState | null | undefined) {
    return Boolean(pane && pane.tabIds.length > 0);
}

export const useAppShellDirectionalTabs = (options: IUseAppShellDirectionalTabsOptions) => {
    const {
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
    } = options;

    const splitCacheCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const canTransferTabsAcrossWindows = computed(() => hasElectronAPI());

    function getDirectionalTargetPane(sourcePaneId: string, direction: TPaneDirection) {
        return findDirectionalPane(sourcePaneId, direction, false);
    }

    function buildDirectionalCommandAvailability(
        pane: IEditorPaneState,
        hasActiveTab: boolean,
        transitionsBusy: boolean,
    ) {
        const focus = createDirectionalAvailability(false);
        const move = createDirectionalAvailability(false);
        const copy = createDirectionalAvailability(false);

        for (const direction of DIRECTION_ORDER) {
            const focusTarget = findDirectionalPane(pane.paneId, direction, true);
            const directionalTarget = getDirectionalTargetPane(pane.paneId, direction);
            const hasUsableDirectionalPane = hasTabs(directionalTarget);
            const canUseDirectionalPane = hasActiveTab && hasUsableDirectionalPane && !transitionsBusy;

            focus[direction] = panes.value.length > 1 && hasTabs(focusTarget) && !transitionsBusy;
            move[direction] = canUseDirectionalPane;
            copy[direction] = canUseDirectionalPane;
        }

        return {
            focus,
            move,
            copy,
        };
    }

    function buildTabContextAvailabilityForPane(
        pane: IEditorPaneState,
        transitionsBusy: boolean,
    ): ITabContextAvailability {
        const activeTabIdForPane = pane.activeTabId;
        const hasActiveTab = Boolean(activeTabIdForPane);
        const closeBlocked = activeTabIdForPane
            ? isSingletonPlaceholderCloseBlocked(pane.paneId, activeTabIdForPane)
            : false;
        const {
            focus,
            move,
            copy,
        } = buildDirectionalCommandAvailability(pane, hasActiveTab, transitionsBusy);

        return {
            split: createDirectionalAvailability(hasActiveTab && !transitionsBusy),
            splitEmpty: createDirectionalAvailability(!transitionsBusy),
            focus,
            move,
            copy,
            canClose: hasActiveTab && !transitionsBusy && !closeBlocked,
            canCreate: true,
            canMoveToNewWindow: canTransferTabsAcrossWindows.value && tabs.value.length > 1 && !transitionsBusy,
            canMoveToWindow: canTransferTabsAcrossWindows.value && !transitionsBusy,
        };
    }

    function scheduleSplitCacheCleanup(tabId: string, entryId: string | null) {
        if (!entryId) {
            return;
        }

        const previousTimer = splitCacheCleanupTimers.get(tabId);
        if (previousTimer) {
            clearTimeout(previousTimer);
        }

        const timer = setTimeout(() => {
            splitCacheCleanupTimers.delete(tabId);
            const workspace = workspaceRefs.value.get(tabId);
            // DjVu mode has hasPdf=false; without this check the cache entry would never be cleared
            if (workspace && (workspaceHasPdf(workspace) || workspace.getToolbarSnapshot().isDjvuMode)) {
                workspaceSplitCache.clear(tabId, entryId);
            }
        }, TAB_TRANSITION_CACHE_GRACE_MS);
        timer.unref?.();
        splitCacheCleanupTimers.set(tabId, timer);
    }

    async function captureActiveTabPayload() {
        const sourcePane = getPaneById(activePaneId.value);
        const sourceTabId = sourcePane?.activeTabId ?? null;
        const sourceTab = getTabById(sourceTabId);
        if (!sourcePane || !sourceTabId || !sourceTab) {
            return null;
        }

        const payload = await captureWorkspacePayload(sourceTabId);
        if (!payload) {
            return null;
        }

        return {
            payload,
            sourcePane,
            sourceTab,
            sourceTabId,
        };
    }

    async function createIndependentSplitRestorePayload(payload: TSplitPayload): Promise<TSplitPayload> {
        if (payload.kind !== 'pdfSnapshot') {
            return payload;
        }

        const snapshotPath = await getDocumentWorkingCopyCapability().createWorkingCopyFromPath(
            payload.snapshotPath,
            payload.originalPath ?? undefined,
        );
        return {
            ...payload,
            snapshotPath,
        };
    }

    const tabContextAvailabilityByPane = computed<Record<string, ITabContextAvailability>>(() => {
        const result: Record<string, ITabContextAvailability> = {};
        const transitionsBusy = isTabTransitionBusy.value;

        for (const pane of panes.value) {
            result[pane.paneId] = buildTabContextAvailabilityForPane(pane, transitionsBusy);
        }

        return result;
    });

    async function splitEditor(direction: TPaneDirection) {
        await enqueueTabTransition(async () => {
            const activeTabPayload = await captureActiveTabPayload();
            if (!activeTabPayload) {
                return;
            }
            const {
                payload,
                sourcePane,
                sourceTab,
                sourceTabId,
            } = activeTabPayload;

            const cacheEntryId = workspaceSplitCache.set(sourceTabId, payload);
            scheduleSplitCacheCleanup(sourceTabId, cacheEntryId);

            const targetPayload = await createIndependentSplitRestorePayload(payload);
            const newPaneId = splitPane(sourcePane.paneId, direction);
            if (!newPaneId) {
                await cleanupSplitPayloadSnapshot(targetPayload, {
                    logSection: 'split-cache',
                    context: 'split-editor-pane-create-failed',
                    metadata: { tabId: sourceTabId },
                });
                return;
            }

            const newTab = createTab({
                paneId: newPaneId,
                activate: false,
                initial: {
                    fileName: sourceTab.fileName,
                    originalPath: sourceTab.originalPath,
                    isDirty: sourceTab.isDirty,
                    isDjvu: sourceTab.isDjvu,
                },
            });

            const restored = await restoreWorkspacePayload(newTab.id, targetPayload);
            if (!restored) {
                await cleanupSplitPayloadSnapshot(targetPayload, {
                    logSection: 'split-cache',
                    context: 'split-editor-restore-failed',
                    metadata: { tabId: newTab.id },
                });
                removeTabFromState(newTab.id);
                activateTab(sourcePane.paneId, sourceTabId);
                return;
            }

            activatePane(sourcePane.paneId);
            activateTab(sourcePane.paneId, sourceTabId);
            cleanupEmptyPanes();
        });
    }

    async function splitEditorEmpty(direction: TPaneDirection) {
        await enqueueTabTransition(async () => {
            const sourcePane = getPaneById(activePaneId.value);
            const sourceTabId = sourcePane?.activeTabId ?? null;
            if (!sourcePane) {
                return;
            }

            if (sourceTabId) {
                const payload = await captureWorkspacePayload(sourceTabId);
                if (payload) {
                    const cacheEntryId = workspaceSplitCache.set(sourceTabId, payload);
                    scheduleSplitCacheCleanup(sourceTabId, cacheEntryId);
                }
            }

            const newPaneId = splitPane(sourcePane.paneId, direction);
            if (!newPaneId) {
                return;
            }

            createTab({
                paneId: newPaneId,
                activate: true,
            });

            activatePane(newPaneId);
        });
    }

    function focusEditorPane(direction: TPaneDirection) {
        if (isTabTransitionBusy.value) {
            return;
        }
        focusPane(direction, true);
    }

    function ensureTargetPaneForDirection(direction: TPaneDirection) {
        const sourcePane = getPaneById(activePaneId.value);
        if (!sourcePane) {
            return null;
        }

        const existing = getDirectionalTargetPane(sourcePane.paneId, direction);
        if (!existing || existing.tabIds.length === 0) {
            return null;
        }

        return {
            sourcePane,
            targetPaneId: existing.paneId,
        };
    }

    async function moveActiveTab(direction: TPaneDirection) {
        await enqueueTabTransition(async () => {
            const sourcePane = getPaneById(activePaneId.value);
            const sourceTabId = sourcePane?.activeTabId ?? null;
            if (!sourcePane || !sourceTabId) {
                return;
            }

            const route = ensureTargetPaneForDirection(direction);
            if (!route) {
                return;
            }

            const remainingSourceTabIds = sourcePane.tabIds.filter(id => id !== sourceTabId);
            const sourceTabIndex = sourcePane.tabIds.indexOf(sourceTabId);
            const sourceReplacementTabId = remainingSourceTabIds[sourceTabIndex]
                ?? remainingSourceTabIds[sourceTabIndex - 1]
                ?? null;
            if (sourceReplacementTabId) {
                activateTab(sourcePane.paneId, sourceReplacementTabId);
                await nextTick();
            }

            const payload = await captureWorkspacePayload(sourceTabId);
            if (!payload) {
                return;
            }

            if ((payload as { kind?: string }).kind !== 'empty') {
                const cacheEntryId = workspaceSplitCache.set(sourceTabId, payload);
                scheduleSplitCacheCleanup(sourceTabId, cacheEntryId);
            }

            const moved = moveTabToPane(sourceTabId, route.targetPaneId, true);
            if (moved) {
                activateTab(route.targetPaneId, sourceTabId);
            }
            cleanupEmptyPanes();
        });
    }

    async function copyActiveTab(direction: TPaneDirection) {
        await enqueueTabTransition(async () => {
            const activeTabPayload = await captureActiveTabPayload();
            if (!activeTabPayload) {
                return;
            }
            const {
                payload,
                sourcePane,
                sourceTab,
                sourceTabId,
            } = activeTabPayload;

            const route = ensureTargetPaneForDirection(direction);
            if (!route) {
                return;
            }

            const targetTab = createTab({
                paneId: route.targetPaneId,
                activate: true,
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
                activateTab(sourcePane.paneId, sourceTabId);
                return;
            }

            activateTab(route.targetPaneId, targetTab.id);
            cleanupEmptyPanes();
        });
    }

    async function closeOtherTabs(paneId: string, tabId: string) {
        const pane = getPaneById(paneId);
        if (!pane) {
            return;
        }
        const targetIds = pane.tabIds.filter(id => id !== tabId);
        for (const id of targetIds) {
            await handleCloseTab(paneId, id);
        }
    }

    async function closeTabsToRight(paneId: string, tabId: string) {
        const pane = getPaneById(paneId);
        if (!pane) {
            return;
        }
        const index = pane.tabIds.indexOf(tabId);
        if (index < 0) {
            return;
        }
        const targetIds = pane.tabIds.slice(index + 1);
        for (const id of targetIds) {
            await handleCloseTab(paneId, id);
        }
    }

    function getTabFilePath(tabId: string) {
        const path = getTabById(tabId)?.originalPath ?? null;
        return typeof path === 'string' && path.trim().length > 0 && !isBrowserDocumentRef(path)
            ? path
            : null;
    }

    async function revealTabInFolder(tabId: string) {
        const path = getTabFilePath(tabId);
        if (!path) {
            return;
        }
        try {
            await getDocumentWindowCapability().showItemInFolder(path);
        } catch {
            // Best-effort; revealing in the file manager can fail if the file moved.
        }
    }

    async function copyTabPath(tabId: string) {
        const path = getTabFilePath(tabId);
        if (!path) {
            return;
        }
        try {
            await globalThis.navigator?.clipboard?.writeText(path);
        } catch {
            // Best-effort; clipboard access can be denied.
        }
    }

    function isDirectionalContextCommand(command: TTabContextCommand): command is TDirectionalTabContextCommand {
        return 'direction' in command;
    }

    function getStaticContextCommandRunner(
        paneId: string,
        tabId: string,
        command: TStaticTabContextCommand,
    ) {
        if (command.kind === 'move-to-window') {
            return () => enqueueTabTransition(() => moveTabToWindow(command.targetWindowId, tabId));
        }

        const handlers = {
            'new-tab': () => {
                createTab({
                    paneId,
                    activate: true,
                });
                return Promise.resolve();
            },
            'close-tab': () => handleCloseTab(paneId, tabId),
            'close-others': () => closeOtherTabs(paneId, tabId),
            'close-right': () => closeTabsToRight(paneId, tabId),
            'reveal-in-folder': () => revealTabInFolder(tabId),
            'copy-path': () => copyTabPath(tabId),
            'move-to-new-window': () => enqueueTabTransition(() => moveTabToNewWindow(tabId)),
        } satisfies Record<TStaticTabContextCommandWithoutTargetWindow['kind'], () => Promise<void>>;

        return handlers[command.kind];
    }

    async function runDirectionalContextCommand(command: TDirectionalTabContextCommand) {
        const handlers = {
            split: splitEditor,
            'split-empty': splitEditorEmpty,
            focus: (direction) => {
                focusEditorPane(direction);
                return Promise.resolve();
            },
            move: moveActiveTab,
            copy: copyActiveTab,
        } satisfies Record<TDirectionalTabContextCommand['kind'], (direction: TPaneDirection) => Promise<void>>;

        await handlers[command.kind](command.direction);
    }

    async function handleTabContextCommand(
        paneId: string,
        tabId: string,
        command: TTabContextCommand,
    ) {
        const pane = getPaneById(paneId);
        if (!pane) {
            return;
        }

        activatePane(paneId);
        activateTab(paneId, tabId);
        await runTabContextCommand(paneId, tabId, command);
    }

    async function runTabContextCommand(
        paneId: string,
        tabId: string,
        command: TTabContextCommand,
    ) {
        if (isDirectionalContextCommand(command)) {
            await runDirectionalContextCommand(command);
            return;
        }

        await getStaticContextCommandRunner(paneId, tabId, command)();
    }

    function handleTabMoveDirection(
        paneId: string,
        tabId: string,
        direction: 'left' | 'right',
    ) {
        const pane = getPaneById(paneId);
        if (!pane || !pane.tabIds.includes(tabId)) {
            return;
        }

        activatePane(paneId);
        activateTab(paneId, tabId);
        void moveActiveTab(direction);
    }

    function cleanup() {
        for (const timer of splitCacheCleanupTimers.values()) {
            clearTimeout(timer);
        }
        splitCacheCleanupTimers.clear();
    }

    return {
        tabContextAvailabilityByPane,
        splitEditor,
        splitEditorEmpty,
        focusEditorPane,
        moveActiveTab,
        copyActiveTab,
        handleTabContextCommand,
        handleTabMoveDirection,
        cleanup,
    };
};
