import type { Ref } from 'vue';
import type {
    IWindowTabIncomingTransfer,
    ITransferredTabState,
    TSplitPayload,
    TWindowTabTransferTarget,
} from '@contracts/windowTabs';
import type { TEditorLayoutNode } from '@app/types/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    collectMergeTabOrder,
    shouldCloseSourceWindowAfterTransfer,
} from '@app/modules/workspace-shell/composables/windowTabTransferOrchestration';
import { workspaceHasPdf } from '@app/modules/workspace-shell/composables/useMenuSync';
import { cleanupSplitPayloadSnapshot } from '@app/modules/workspace-shell/composables/workspaceSplitPayloadCleanup';
import { getWindowTabsCapability } from '@app/utils/platformWindowTabs';
import { getErrorMessage } from '@app/utils/error';

interface IPaneLike {
    id: string;
    activeTabId: string | null;
    tabIds: string[];
}

type TSourceTransferOutcome = 'success' | 'failed' | 'window-closed';

interface IIncomingTransferTargetTab {
    tabId: string;
    created: boolean;
}

interface IIncomingTransferTarget {
    pane: IPaneLike;
    tab: IIncomingTransferTargetTab;
}

interface IUseWindowTabTransfersOptions {
    activePaneId: Ref<string | null>;
    panes: Ref<IPaneLike[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    createTab: (options: {
        paneId?: string;
        activate?: boolean;
        initial?: Partial<ITab>;
    }) => ITab;
    getPaneById: (paneId: string | null | undefined) => IPaneLike | null;
    getTabById: (tabId: string | null | undefined) => ITab | null;
    getPaneByTabId: (tabId: string) => IPaneLike | null;
    activatePane: (paneId: string) => void;
    activateTab: (paneId: string, tabId: string) => void;
    removeTabFromState: (tabId: string) => void;
    cleanupEmptyPanes: () => void;
    closeTabInState: (paneId: string, tabId: string) => void;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    waitForWorkspace: (tabId: string, timeoutMs?: number) => Promise<IWorkspaceExpose | null>;
    workspaceRestoreTracker: {
        start: (tabId: string) => void;
        finish: (tabId: string) => void;
    };
    handleCloseTab: (paneId: string, tabId: string) => Promise<void>;
    handoffActiveTabBeforeClose: (paneId: string, tabId: string) => Promise<void>;
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

function isOnlyOpenTargetTab(targetPane: IPaneLike, totalTabCount: number) {
    return targetPane.tabIds.length === 1 && totalTabCount === 1;
}

function canReuseIncomingTransferTab(
    tab: ITab | null,
    targetPane: IPaneLike,
    totalTabCount: number,
    existingHasDocument: boolean,
): tab is ITab {
    return !!tab
        && isOnlyOpenTargetTab(targetPane, totalTabCount)
        && isPlaceholderTab(tab)
        && !existingHasDocument;
}

export const useWindowTabTransfers = (options: IUseWindowTabTransfersOptions) => {
    const { t } = useTypedI18n();

    function getIncomingTransferTabContext(targetPane: IPaneLike) {
        const existingTabId = targetPane.tabIds[0] ?? null;
        const existingTab = options.getTabById(existingTabId);
        const existingWorkspace = existingTabId ? options.workspaceRefs.value.get(existingTabId) ?? null : null;

        return {
            existingTab,
            existingHasDocument: workspaceHasPdf(existingWorkspace),
        };
    }

    function createIncomingTransferTargetTab(targetPane: IPaneLike): IIncomingTransferTargetTab {
        const createdTab = options.createTab({
            paneId: targetPane.id,
            activate: false,
        });

        return {
            tabId: createdTab.id,
            created: true,
        };
    }

    function reuseIncomingTransferTargetTab(targetPane: IPaneLike, existingTab: ITab): IIncomingTransferTargetTab {
        options.activatePane(targetPane.id);
        options.activateTab(targetPane.id, existingTab.id);
        return {
            tabId: existingTab.id,
            created: false,
        };
    }

    function resolveIncomingTransferTargetTab(targetPaneId: string): IIncomingTransferTargetTab | null {
        const targetPane = options.getPaneById(targetPaneId);
        if (!targetPane) {
            return null;
        }

        const {
            existingTab,
            existingHasDocument,
        } = getIncomingTransferTabContext(targetPane);
        if (canReuseIncomingTransferTab(existingTab, targetPane, options.tabs.value.length, existingHasDocument)) {
            return reuseIncomingTransferTargetTab(targetPane, existingTab);
        }

        return createIncomingTransferTargetTab(targetPane);
    }

    async function ackIncomingTransferFailure(transferId: string, error: string) {
        await getWindowTabsCapability().transferAck({
            transferId,
            success: false,
            error,
        });
    }

    async function ackIncomingTransferSuccess(transferId: string) {
        await getWindowTabsCapability().transferAck({
            transferId,
            success: true,
        });
    }

    function resolveIncomingTransferTargetPane() {
        return options.getPaneById(options.activePaneId.value) ?? options.panes.value[0] ?? null;
    }

    function removeCreatedTransferTab(targetTab: {
        tabId: string;
        created: boolean;
    }) {
        if (targetTab.created) {
            options.removeTabFromState(targetTab.tabId);
        }
    }

    function applyIncomingTransferTabState(targetPaneId: string, targetTabId: string, transfer: IWindowTabIncomingTransfer) {
        const incomingTab = options.getTabById(targetTabId);
        if (incomingTab) {
            Object.assign(incomingTab, transfer.tab);
        }
        options.activatePane(targetPaneId);
        options.activateTab(targetPaneId, targetTabId);
    }

    async function prepareIncomingTransferTarget(transferId: string): Promise<IIncomingTransferTarget | null> {
        const targetPane = resolveIncomingTransferTargetPane();
        if (!targetPane) {
            await ackIncomingTransferFailure(transferId, t('tabs.transferErrors.noTargetPane'));
            return null;
        }

        const targetTab = resolveIncomingTransferTargetTab(targetPane.id);
        if (!targetTab) {
            await ackIncomingTransferFailure(transferId, t('tabs.transferErrors.noTargetTab'));
            return null;
        }

        return {
            pane: targetPane,
            tab: targetTab,
        };
    }

    async function captureWorkspacePayload(
        tabId: string,
        timeoutMs = 4000,
    ): Promise<TSplitPayload | null> {
        const workspace = await options.waitForWorkspace(tabId, timeoutMs);
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

    async function tryRestoreWorkspacePayload(tabId: string, payload: TSplitPayload) {
        try {
            const workspace = await options.waitForWorkspace(tabId);
            if (!workspace) {
                return false;
            }
            await workspace.restoreSplitPayload(payload);
            await nextTick();

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
        }
    }

    async function cleanupFailedRestorePayload(tabId: string, payload: TSplitPayload) {
        await cleanupSplitPayloadSnapshot(payload, {
            logSection: 'tabs',
            context: 'restore-workspace-payload',
            metadata: { tabId },
        });
    }

    async function restoreWorkspacePayload(tabId: string, payload: TSplitPayload | null) {
        if (!payload) {
            return false;
        }

        options.workspaceRestoreTracker.start(tabId);
        let restored = false;
        try {
            restored = await tryRestoreWorkspacePayload(tabId, payload);
            return restored;
        } finally {
            if (!restored) {
                await cleanupFailedRestorePayload(tabId, payload);
            }
            options.workspaceRestoreTracker.finish(tabId);
        }
    }

    async function closeSourceWorkspaceWithoutPersist(paneId: string, tabId: string) {
        await options.handoffActiveTabBeforeClose(paneId, tabId);

        const workspace = options.workspaceRefs.value.get(tabId);
        if (!workspace || !workspaceHasPdf(workspace)) {
            return true;
        }

        options.workspaceRestoreTracker.start(tabId);
        try {
            return await workspace.handleCloseFileFromUi({persist: false});
        } catch (error) {
            BrowserLogger.error('tabs', 'Failed to close source workspace after transfer', {
                tabId,
                error,
            });
            return false;
        } finally {
            options.workspaceRestoreTracker.finish(tabId);
        }
    }

    async function finalizeTransferredSourceTab(paneId: string, tabId: string): Promise<TSourceTransferOutcome> {
        const sourceCloseSucceeded = await closeSourceWorkspaceWithoutPersist(paneId, tabId);
        if (!sourceCloseSucceeded) {
            return 'failed';
        }

        if (shouldCloseSourceWindowAfterTransfer(options.tabs.value.length, true)) {
            const closed = await getWindowTabsCapability().closeCurrentWindow();
            if (closed) {
                return 'window-closed';
            }
        }

        options.closeTabInState(paneId, tabId);
        options.cleanupEmptyPanes();
        return 'success';
    }

    async function transferTabToTarget(tabId: string, target: TWindowTabTransferTarget): Promise<TSourceTransferOutcome> {
        const tab = options.getTabById(tabId);
        const sourcePane = options.getPaneByTabId(tabId);
        if (!tab || !sourcePane) {
            return 'failed';
        }

        const payload = await captureWorkspacePayload(tab.id);
        if (!payload) {
            return 'failed';
        }

        const transferResult = await getWindowTabsCapability().transfer({
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
            await cleanupSplitPayloadSnapshot(payload, {
                logSection: 'tabs',
                context: 'transfer-tab-to-target',
                metadata: {
                    tabId,
                    target,
                },
            });
            return 'failed';
        }

        return finalizeTransferredSourceTab(sourcePane.id, tab.id);
    }

    async function moveTabToNewWindow(tabId?: string) {
        const resolvedTabId = tabId;
        if (!resolvedTabId) {
            return;
        }
        await transferTabToTarget(resolvedTabId, {kind: 'new-window'});
    }

    async function moveTabToWindow(targetWindowId: number, tabId?: string) {
        const resolvedTabId = tabId;
        if (!resolvedTabId) {
            return;
        }
        await transferTabToTarget(resolvedTabId, {
            kind: 'window',
            windowId: targetWindowId,
        });
    }

    async function mergeWindowInto(targetWindowId: number) {
        const orderedTabIds = collectMergeTabOrder(options.layout.value, options.panes.value, options.tabs.value);
        for (const tabId of orderedTabIds) {
            if (!options.getTabById(tabId)) {
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
        try {
            const target = await prepareIncomingTransferTarget(transfer.transferId);
            if (!target) {
                return;
            }

            const restored = await restoreWorkspacePayload(target.tab.tabId, transfer.payload);
            if (!restored) {
                removeCreatedTransferTab(target.tab);
                await ackIncomingTransferFailure(transfer.transferId, t('tabs.transferErrors.restoreFailed'));
                return;
            }

            applyIncomingTransferTabState(target.pane.id, target.tab.tabId, transfer);
            await ackIncomingTransferSuccess(transfer.transferId);
        } catch (error) {
            BrowserLogger.error('tabs', 'Unhandled incoming tab transfer failure', {
                transferId: transfer.transferId,
                error,
            });

            await ackIncomingTransferFailure(transfer.transferId, getErrorMessage(error));
        }
    }

    return {
        captureWorkspacePayload,
        restoreWorkspacePayload,
        handleIncomingTabTransfer,
        moveTabToNewWindow,
        moveTabToWindow,
        mergeWindowInto,
    };
};
