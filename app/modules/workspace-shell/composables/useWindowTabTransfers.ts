import type { Ref } from 'vue';
import type {
    IWindowTabIncomingTransfer,
    ITransferredTabState,
    TSplitPayload,
    TWindowTabTransferTarget,
} from '@contracts/window-tabs';
import type { TEditorLayoutNode } from '@app/types/editor-groups';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import { BrowserLogger } from '@app/utils/browser-logger';
import { getElectronAPI } from '@app/utils/platform';
import {
    collectMergeTabOrder,
    shouldCloseSourceWindowAfterTransfer,
} from '@app/modules/workspace-shell/composables/window-tab-transfer-orchestration';
import { workspaceHasPdf } from '@app/modules/workspace-shell/composables/useMenuSync';
import { cleanupSplitPayloadSnapshot } from '@app/modules/workspace-shell/composables/workspace-split-payload-cleanup';

interface IGroupLike {
    id: string;
    activeTabId: string | null;
    tabIds: string[];
}

type TSourceTransferOutcome = 'success' | 'failed' | 'window-closed';

interface IUseWindowTabTransfersOptions {
    activeGroupId: Ref<string | null>;
    groups: Ref<IGroupLike[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    createTab: (options: {
        groupId?: string;
        activate?: boolean;
        initial?: Partial<ITab>;
    }) => ITab;
    getGroupById: (groupId: string | null | undefined) => IGroupLike | null;
    getTabById: (tabId: string | null | undefined) => ITab | null;
    getGroupByTabId: (tabId: string) => IGroupLike | null;
    activateGroup: (groupId: string) => void;
    activateTab: (groupId: string, tabId: string) => void;
    removeTabFromState: (tabId: string) => void;
    cleanupEmptyGroups: () => void;
    closeTabInState: (groupId: string, tabId: string) => void;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    waitForWorkspace: (tabId: string, timeoutMs?: number) => Promise<IWorkspaceExpose | null>;
    workspaceRestoreTracker: {
        start: (tabId: string) => void;
        finish: (tabId: string) => void;
    };
    t: (key: string) => string;
    handleCloseTab: (groupId: string, tabId: string) => Promise<void>;
    handoffActiveTabBeforeClose: (groupId: string, tabId: string) => Promise<void>;
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

export function useWindowTabTransfers(options: IUseWindowTabTransfersOptions) {
    function resolveIncomingTransferTargetTab(
        targetGroupId: string,
    ): {
        tabId: string;
        created: boolean;
    } | null {
        const targetGroup = options.getGroupById(targetGroupId);
        if (!targetGroup) {
            return null;
        }

        const existingTabId = targetGroup.tabIds[0] ?? null;
        const existingTab = options.getTabById(existingTabId);
        const existingWorkspace = existingTabId ? options.workspaceRefs.value.get(existingTabId) ?? null : null;
        const existingHasDocument = workspaceHasPdf(existingWorkspace);

        if (
            existingTab
            && targetGroup.tabIds.length === 1
            && options.tabs.value.length === 1
            && isPlaceholderTab(existingTab)
            && !existingHasDocument
        ) {
            options.activateGroup(targetGroup.id);
            options.activateTab(targetGroup.id, existingTab.id);
            return {
                tabId: existingTab.id,
                created: false,
            };
        }

        const createdTab = options.createTab({
            groupId: targetGroup.id,
            activate: false,
        });

        return {
            tabId: createdTab.id,
            created: true,
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

    async function restoreWorkspacePayload(tabId: string, payload: TSplitPayload | null) {
        if (!payload) {
            return false;
        }

        options.workspaceRestoreTracker.start(tabId);
        let restored = false;
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

            restored = true;
            return true;
        } catch (error) {
            BrowserLogger.error('tabs', 'Failed to restore split payload', {
                tabId,
                payloadKind: payload.kind,
                error,
            });
            return false;
        } finally {
            if (!restored) {
                await cleanupSplitPayloadSnapshot(payload, {
                    logSection: 'tabs',
                    context: 'restore-workspace-payload',
                    metadata: { tabId },
                });
            }
            options.workspaceRestoreTracker.finish(tabId);
        }
    }

    async function closeSourceWorkspaceWithoutPersist(groupId: string, tabId: string) {
        await options.handoffActiveTabBeforeClose(groupId, tabId);

        const workspace = options.workspaceRefs.value.get(tabId);
        if (!workspace || !workspaceHasPdf(workspace)) {
            return true;
        }

        options.workspaceRestoreTracker.start(tabId);
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
            options.workspaceRestoreTracker.finish(tabId);
        }
    }

    async function finalizeTransferredSourceTab(groupId: string, tabId: string): Promise<TSourceTransferOutcome> {
        const sourceCloseSucceeded = await closeSourceWorkspaceWithoutPersist(groupId, tabId);
        if (!sourceCloseSucceeded) {
            return 'failed';
        }

        if (shouldCloseSourceWindowAfterTransfer(options.tabs.value.length, true)) {
            const closed = await getElectronAPI().windowTabs.closeCurrentWindow();
            if (closed) {
                return 'window-closed';
            }
        }

        options.closeTabInState(groupId, tabId);
        options.cleanupEmptyGroups();
        return 'success';
    }

    async function transferTabToTarget(tabId: string, target: TWindowTabTransferTarget): Promise<TSourceTransferOutcome> {
        const tab = options.getTabById(tabId);
        const sourceGroup = options.getGroupByTabId(tabId);
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

        return finalizeTransferredSourceTab(sourceGroup.id, tab.id);
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
        const orderedTabIds = collectMergeTabOrder(options.layout.value, options.groups.value, options.tabs.value);
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
        const ackFailure = async (error: string) => {
            await getElectronAPI().windowTabs.transferAck({
                transferId: transfer.transferId,
                success: false,
                error,
            });
        };

        try {
            const targetGroup = options.getGroupById(options.activeGroupId.value) ?? options.groups.value[0] ?? null;
            if (!targetGroup) {
                await ackFailure(options.t('tabs.transferErrors.noTargetGroup'));
                return;
            }

            const targetTab = resolveIncomingTransferTargetTab(targetGroup.id);
            if (!targetTab) {
                await ackFailure(options.t('tabs.transferErrors.noTargetTab'));
                return;
            }

            const restored = await restoreWorkspacePayload(targetTab.tabId, transfer.payload);
            if (!restored) {
                if (targetTab.created) {
                    options.removeTabFromState(targetTab.tabId);
                }
                await ackFailure(options.t('tabs.transferErrors.restoreFailed'));
                return;
            }

            const incomingTab = options.getTabById(targetTab.tabId);
            if (incomingTab) {
                Object.assign(incomingTab, transfer.tab);
            }
            options.activateGroup(targetGroup.id);
            options.activateTab(targetGroup.id, targetTab.tabId);

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

    return {
        captureWorkspacePayload,
        restoreWorkspacePayload,
        handleIncomingTabTransfer,
        moveTabToNewWindow,
        moveTabToWindow,
        mergeWindowInto,
    };
}
