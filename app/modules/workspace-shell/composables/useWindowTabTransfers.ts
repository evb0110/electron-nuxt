import type { Ref } from 'vue';
import type {
    ITransferredTabState,
    IWindowTabTransferSessionState,
    IWindowTabIncomingTransfer,
    TSplitPayload,
    TWindowTabTransferTarget,
} from '@contracts/windowTabs';
import type { TEditorLayoutNode } from '@contracts/editorPanes';
import type {
    ITab,
    TTabUpdate,
} from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { BrowserLogger } from '@app/utils/browserLogger';
import { collectMergeTabOrder } from '@app/modules/workspace-shell/window-tabs/collectMergeTabOrder';
import { shouldCloseSourceWindowAfterTransfer } from '@app/modules/workspace-shell/window-tabs/shouldCloseSourceWindowAfterTransfer';
import { workspaceHasPdf } from '@app/modules/workspace-shell/state/workspaceHasPdf';
import { cleanupSplitPayloadSnapshot } from '@app/modules/workspace-shell/splits/cleanupSplitPayloadSnapshot';
import { getWindowTabsCapability } from '@app/utils/platformWindowTabs';
import { getErrorMessage } from '@app/utils/error';
import { withTimeout } from 'es-toolkit/promise';
import { createWorkspaceSplitCacheSessionState } from '@app/modules/workspace-shell/document-sessions/createWorkspaceSplitCacheSessionState';
import type { IWorkspaceDocumentSessionController } from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';
import { resolveDocumentRefBackend } from '@app/utils/documentRef';

interface IPaneLike {
    paneId: string;
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

interface IPreparedTransferItem {
    tabId: string;
    payload: TSplitPayload;
    commandTarget: TWorkspaceCommandTarget | null;
    session: IWindowTabTransferSessionState | null;
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
    updateTab: (tabId: string, updates: TTabUpdate) => void;
    cleanupEmptyPanes: () => void;
    closeTabInState: (paneId: string, tabId: string) => void;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    documentSessionsByTabId?: Ref<Record<string, IWorkspaceDocumentSessionController>>;
    waitForWorkspace: (tabId: string, timeoutMs?: number) => Promise<IWorkspaceExpose | null>;
    workspaceRestoreTracker: {
        start: (tabId: string) => void;
        finish: (tabId: string) => void;
    };
    handleCloseTab: (paneId: string, tabId: string) => Promise<void>;
    handoffActiveTabBeforeClose: (paneId: string, tabId: string) => Promise<void>;
}

const DEFAULT_CAPTURE_TIMEOUT_MS = 4000;
const MERGE_CAPTURE_TIMEOUT_MS = 4000;

function buildTransferredTabState(
    tab: ITab,
    session: IWorkspaceDocumentSessionController | null,
): ITransferredTabState {
    const sessionTab = session?.toDocumentRecord().tab;
    const originalPath = sessionTab?.originalPath ?? tab.originalPath;
    const originalBackend = resolveDocumentRefBackend(originalPath);
    const documentInstanceId = sessionTab?.documentInstanceId ?? tab.documentInstanceId ?? null;
    return {
        fileName: sessionTab?.fileName ?? tab.fileName,
        originalPath,
        ...(originalBackend === undefined ? {} : {originalBackend}),
        documentInstanceId,
        isDirty: sessionTab?.isDirty ?? tab.isDirty,
        isDjvu: sessionTab?.isDjvu ?? tab.isDjvu,
    };
}

function isPlaceholderTab(tab: ITab) {
    return tab.fileName === null
        && tab.originalPath === null
        && !tab.isDirty
        && !tab.isDjvu;
}

function isOnlyOpenTargetTab(targetPane: IPaneLike) {
    return targetPane.tabIds.length === 1;
}

function canReuseIncomingTransferTab(
    tab: ITab | null,
    targetPane: IPaneLike,
    existingHasDocument: boolean,
): tab is ITab {
    return !!tab
        && isOnlyOpenTargetTab(targetPane)
        && isPlaceholderTab(tab)
        && !existingHasDocument;
}

export const useWindowTabTransfers = (options: IUseWindowTabTransfersOptions) => {
    const { t } = useTypedI18n();

    function getDocumentSession(tabId: string | null | undefined) {
        return tabId ? options.documentSessionsByTabId?.value[tabId] ?? null : null;
    }

    function getTransferSessionState(tabId: string): IWindowTabTransferSessionState | null {
        return createWorkspaceSplitCacheSessionState(getDocumentSession(tabId));
    }

    function isCommandTargetCurrent(
        session: IWorkspaceDocumentSessionController | null,
        target: TWorkspaceCommandTarget | null,
    ) {
        return !target || session?.validateCommandTarget(target).ok === true;
    }

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
            paneId: targetPane.paneId,
            activate: true,
        });

        return {
            tabId: createdTab.id,
            created: true,
        };
    }

    function reuseIncomingTransferTargetTab(targetPane: IPaneLike, existingTab: ITab): IIncomingTransferTargetTab {
        options.activatePane(targetPane.paneId);
        options.activateTab(targetPane.paneId, existingTab.id);
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
        if (canReuseIncomingTransferTab(existingTab, targetPane, existingHasDocument)) {
            return reuseIncomingTransferTargetTab(targetPane, existingTab);
        }

        return createIncomingTransferTargetTab(targetPane);
    }

    async function ackIncomingTransferFailure(transferId: string, error: string) {
        try {
            const acked = await getWindowTabsCapability().transferAck({
                transferId,
                success: false,
                error,
            });
            if (!acked) {
                BrowserLogger.warn('tabs', 'Incoming tab transfer failure ack was not accepted', {
                    transferId,
                    error,
                });
            }
        } catch (ackError) {
            BrowserLogger.warn('tabs', 'Failed to ack incoming tab transfer failure', {
                transferId,
                error,
                ackError,
            });
        }
    }

    async function ackIncomingTransferSuccess(transferId: string) {
        try {
            const acked = await getWindowTabsCapability().transferAck({
                transferId,
                success: true,
            });
            if (!acked) {
                BrowserLogger.warn('tabs', 'Incoming tab transfer success ack was not accepted', { transferId });
            }
        } catch (ackError) {
            BrowserLogger.warn('tabs', 'Failed to ack incoming tab transfer success', {
                transferId,
                ackError,
            });
        }
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
        options.updateTab(targetTabId, transfer.tab);
        options.activatePane(targetPaneId);
        options.activateTab(targetPaneId, targetTabId);
    }

    function isIncomingTransferSessionCurrent(targetTabId: string, transfer: IWindowTabIncomingTransfer) {
        const expected = transfer.session;
        if (!expected) {
            return true;
        }
        const snapshot = getDocumentSession(targetTabId)?.snapshot.value ?? null;
        return (expected.documentInstanceId ?? null) === (snapshot?.identity.documentInstanceId ?? null);
    }

    async function prepareIncomingTransferTarget(transferId: string): Promise<IIncomingTransferTarget | null> {
        const targetPane = resolveIncomingTransferTargetPane();
        if (!targetPane) {
            await ackIncomingTransferFailure(transferId, t('tabs.transferErrors.noTargetPane'));
            return null;
        }

        const targetTab = resolveIncomingTransferTargetTab(targetPane.paneId);
        if (!targetTab) {
            await ackIncomingTransferFailure(transferId, t('tabs.transferErrors.noTargetTab'));
            return null;
        }

        return {
            pane: targetPane,
            tab: targetTab,
        };
    }

    async function captureWorkspaceTransferItem(
        tabId: string,
        timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
    ): Promise<IPreparedTransferItem | null> {
        const session = getDocumentSession(tabId);
        const commandTarget = session?.createCommandTarget() ?? null;
        if (!isCommandTargetCurrent(session, commandTarget)) {
            return null;
        }

        try {
            return await withTimeout(async () => {
                const workspace = await options.waitForWorkspace(tabId, timeoutMs);
                if (!workspace) {
                    return null;
                }

                if (!isCommandTargetCurrent(session, commandTarget)) {
                    return null;
                }

                const payload = await workspace.captureSplitPayload();
                if (!isCommandTargetCurrent(session, commandTarget)) {
                    await cleanupSplitPayloadSnapshot(payload, {
                        logSection: 'tabs',
                        context: 'capture-workspace-payload-stale-session',
                        metadata: { tabId },
                    });
                    return null;
                }

                return {
                    tabId,
                    payload,
                    commandTarget,
                    session: getTransferSessionState(tabId),
                };
            }, timeoutMs);
        } catch (error) {
            BrowserLogger.error('tabs', 'Failed to capture split payload', {
                tabId,
                error,
            });
            return null;
        }
    }

    async function captureWorkspacePayload(
        tabId: string,
        timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
    ): Promise<TSplitPayload | null> {
        return (await captureWorkspaceTransferItem(tabId, timeoutMs))?.payload ?? null;
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
        if (payload.kind === 'empty') {
            BrowserLogger.warn('tabs', 'Rejected empty split payload for workspace restore', { tabId });
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

    async function transferPreparedTabToTarget(
        item: IPreparedTransferItem,
        target: TWindowTabTransferTarget,
    ): Promise<TSourceTransferOutcome> {
        const {
            tabId,
            payload,
            commandTarget,
        } = item;
        const tab = options.getTabById(tabId);
        const sourcePane = options.getPaneByTabId(tabId);
        if (!tab || !sourcePane) {
            await cleanupSplitPayloadSnapshot(payload, {
                logSection: 'tabs',
                context: 'transfer-tab-source-missing',
                metadata: {
                    tabId,
                    target,
                },
            });
            return 'failed';
        }

        if (!isCommandTargetCurrent(getDocumentSession(tab.id), commandTarget)) {
            await cleanupSplitPayloadSnapshot(payload, {
                logSection: 'tabs',
                context: 'transfer-tab-source-stale-before-transfer',
                metadata: {
                    tabId,
                    target,
                },
            });
            return 'failed';
        }

        let transferResult;
        try {
            transferResult = await getWindowTabsCapability().transfer({
                target,
                tab: buildTransferredTabState(tab, getDocumentSession(tab.id)),
                payload,
                ...(item.session === null ? {} : {session: item.session}),
            });
        } catch (error) {
            BrowserLogger.error('tabs', 'Cross-window transfer threw before completion', {
                tabId,
                target,
                error,
            });
            await cleanupSplitPayloadSnapshot(payload, {
                logSection: 'tabs',
                context: 'transfer-tab-to-target-error',
                metadata: {
                    tabId,
                    target,
                },
            });
            return 'failed';
        }

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

        if (!isCommandTargetCurrent(getDocumentSession(tab.id), commandTarget)) {
            BrowserLogger.warn('tabs', 'Cross-window transfer source changed before source cleanup', {
                tabId,
                target,
            });
            return 'failed';
        }

        return finalizeTransferredSourceTab(sourcePane.paneId, tab.id);
    }

    function tabRequiresNonEmptyTransferPayload(tab: ITab | null) {
        return Boolean(tab?.originalPath ?? tab?.fileName ?? tab?.isDirty ?? tab?.isDjvu);
    }

    function isValidTransferPayloadForTab(tab: ITab | null, payload: TSplitPayload) {
        return !(tabRequiresNonEmptyTransferPayload(tab) && payload.kind === 'empty');
    }

    async function transferTabToTarget(tabId: string, target: TWindowTabTransferTarget): Promise<TSourceTransferOutcome> {
        const item = await captureWorkspaceTransferItem(tabId);
        if (!item) {
            return 'failed';
        }
        const tab = options.getTabById(tabId);
        if (!isValidTransferPayloadForTab(tab, item.payload)) {
            BrowserLogger.warn('tabs', 'Rejected empty split payload for document tab transfer', {
                tabId,
                target,
                fileName: tab?.fileName ?? null,
                originalPath: tab?.originalPath ?? null,
                isDirty: tab?.isDirty ?? false,
                isDjvu: tab?.isDjvu ?? false,
            });
            return 'failed';
        }

        return transferPreparedTabToTarget(item, target);
    }

    async function cleanupPreparedMergeItems(items: IPreparedTransferItem[], context: string) {
        await Promise.all(items.map(item => cleanupSplitPayloadSnapshot(item.payload, {
            logSection: 'tabs',
            context,
            metadata: { tabId: item.tabId },
        })));
    }

    async function captureMergeTransferItems(orderedTabIds: string[]) {
        const sourceTabIds = orderedTabIds.filter(tabId => Boolean(options.getTabById(tabId)));
        const captures = await Promise.all(sourceTabIds.map(async (tabId): Promise<IPreparedTransferItem | null> => {
            return captureWorkspaceTransferItem(tabId, MERGE_CAPTURE_TIMEOUT_MS);
        }));
        const prepared = captures.filter((item): item is IPreparedTransferItem => item !== null);
        if (prepared.length !== sourceTabIds.length) {
            await cleanupPreparedMergeItems(prepared, 'merge-window-preflight-failed');
            return null;
        }

        return prepared;
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
        const preparedItems = await captureMergeTransferItems(orderedTabIds);
        if (!preparedItems) {
            return;
        }

        const pendingItems = new Map(preparedItems.map(item => [
            item.tabId,
            item,
        ]));
        for (const item of preparedItems) {
            pendingItems.delete(item.tabId);
            const result = await transferPreparedTabToTarget(item, {
                kind: 'window',
                windowId: targetWindowId,
            });

            if (result === 'failed' || result === 'window-closed') {
                await cleanupPreparedMergeItems([...pendingItems.values()], 'merge-window-aborted');
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

            applyIncomingTransferTabState(target.pane.paneId, target.tab.tabId, transfer);
            if (!isIncomingTransferSessionCurrent(target.tab.tabId, transfer)) {
                await ackIncomingTransferFailure(transfer.transferId, t('tabs.transferErrors.restoreFailed'));
                return;
            }
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
