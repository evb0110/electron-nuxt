import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import type { TSplitPayload } from '@contracts/windowTabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { useWindowTabTransfers } from '@app/modules/workspace-shell/composables/useWindowTabTransfers';
import { createWorkspaceDocumentSessionCore } from '@app/modules/workspace-shell/document-sessions/createWorkspaceDocumentSessionCore';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { cast } from '@tests/helpers/cast';
import type { ITab } from '@app/types/tabs';

const mocks = vi.hoisted(() => ({
    cleanupSplitPayloadSnapshot: vi.fn(async () => undefined),
    transfer: vi.fn(),
    transferAck: vi.fn(async () => true),
    closeCurrentWindow: vi.fn(async () => false),
}));

vi.mock('@app/modules/workspace-shell/splits/cleanupSplitPayloadSnapshot', () => ({ cleanupSplitPayloadSnapshot: mocks.cleanupSplitPayloadSnapshot }));

vi.mock('@app/utils/platformWindowTabs', () => ({getWindowTabsCapability: () => ({
    transfer: mocks.transfer,
    transferAck: mocks.transferAck,
    closeCurrentWindow: mocks.closeCurrentWindow,
})}));

function createPayload(): TSplitPayload {
    return {
        kind: 'pdfSnapshot',
        fileName: 'sample.pdf',
        originalPath: '/tmp/sample.pdf',
        snapshotPath: '/tmp/snapshot.pdf',
        isDirty: true,
    };
}

describe('useWindowTabTransfers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
    });

    it('cleans prepared payloads when platform transfer throws', async () => {
        const payload = createPayload();
        const tab = {
            id: 'tab-1',
            fileName: 'sample.pdf',
            originalPath: '/tmp/sample.pdf',
            isDirty: true,
            isDjvu: false,
        };
        const pane = {
            paneId: 'pane-1',
            activeTabId: 'tab-1',
            tabIds: ['tab-1'],
        };
        const workspace = cast<IWorkspaceExpose>({
            hasPdf: true,
            captureSplitPayload: vi.fn(async () => payload),
            handleCloseFileFromUi: vi.fn(async () => true),
        });
        mocks.transfer.mockRejectedValueOnce(new Error('transfer failed'));

        const transfers = useWindowTabTransfers({
            activePaneId: ref('pane-1'),
            panes: ref([pane]),
            tabs: ref([tab]),
            layout: ref(null),
            createTab: vi.fn(),
            getPaneById: vi.fn((paneId: string | null | undefined) => paneId === 'pane-1' ? pane : null),
            getTabById: vi.fn((tabId: string | null | undefined) => tabId === 'tab-1' ? tab : null),
            getPaneByTabId: vi.fn((tabId: string) => tabId === 'tab-1' ? pane : null),
            activatePane: vi.fn(),
            activateTab: vi.fn(),
            removeTabFromState: vi.fn(),
            updateTab: vi.fn(),
            cleanupEmptyPanes: vi.fn(),
            closeTabInState: vi.fn(),
            workspaceRefs: ref(new Map<string, IWorkspaceExpose>([[
                'tab-1',
                workspace,
            ]])),
            waitForWorkspace: vi.fn(async (tabId: string): Promise<IWorkspaceExpose | null> => tabId === 'tab-1' ? workspace : null),
            workspaceRestoreTracker: {
                start: vi.fn(),
                finish: vi.fn(),
            },
            handleCloseTab: vi.fn(),
            handoffActiveTabBeforeClose: vi.fn(),
        });

        await transfers.moveTabToNewWindow('tab-1');

        expect(mocks.cleanupSplitPayloadSnapshot).toHaveBeenCalledWith(payload, {
            logSection: 'tabs',
            context: 'transfer-tab-to-target-error',
            metadata: {
                tabId: 'tab-1',
                target: {kind: 'new-window'},
            },
        });
    });

    it('includes source session metadata in outgoing transfers', async () => {
        const payload = createPayload();
        const tab = {
            id: 'tab-1',
            fileName: 'sample.pdf',
            originalPath: '/tmp/sample.pdf',
            isDirty: true,
            isDjvu: false,
        };
        const pane = {
            paneId: 'pane-1',
            activeTabId: 'tab-1',
            tabIds: ['tab-1'],
        };
        const workspace = cast<IWorkspaceExpose>({
            hasPdf: true,
            captureSplitPayload: vi.fn(async () => payload),
            handleCloseFileFromUi: vi.fn(async () => true),
        });
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
            createDocumentInstanceId: () => 'instance-1',
            initialRecord: createWorkspaceDocumentRecord({
                tab,
                documentIdentity: {
                    version: 1,
                    authority: 'browser-document-store',
                    contentRevision: 4,
                    documentRef: '/tmp/sample.pdf',
                    mintedAt: 123,
                    token: 'revision-token-1',
                },
            }),
        });
        mocks.transfer.mockResolvedValueOnce({
            transferId: 'transfer-1',
            success: false,
            targetWindowId: 2,
            error: 'target unavailable',
        });

        const transfers = useWindowTabTransfers({
            activePaneId: ref('pane-1'),
            panes: ref([pane]),
            tabs: ref([tab]),
            layout: ref(null),
            createTab: vi.fn(),
            getPaneById: vi.fn((paneId: string | null | undefined) => paneId === 'pane-1' ? pane : null),
            getTabById: vi.fn((tabId: string | null | undefined) => tabId === 'tab-1' ? tab : null),
            getPaneByTabId: vi.fn((tabId: string) => tabId === 'tab-1' ? pane : null),
            activatePane: vi.fn(),
            activateTab: vi.fn(),
            removeTabFromState: vi.fn(),
            updateTab: vi.fn(),
            cleanupEmptyPanes: vi.fn(),
            closeTabInState: vi.fn(),
            workspaceRefs: ref(new Map<string, IWorkspaceExpose>([[
                'tab-1',
                workspace,
            ]])),
            documentSessionsByTabId: shallowRef({'tab-1': session}),
            waitForWorkspace: vi.fn(async (tabId: string): Promise<IWorkspaceExpose | null> => tabId === 'tab-1' ? workspace : null),
            workspaceRestoreTracker: {
                start: vi.fn(),
                finish: vi.fn(),
            },
            handleCloseTab: vi.fn(),
            handoffActiveTabBeforeClose: vi.fn(),
        });

        await transfers.moveTabToWindow(2, 'tab-1');

        expect(mocks.transfer).toHaveBeenCalledWith(expect.objectContaining({session: {
            sessionId: 'session-1',
            sessionRevision: 0,
            documentRef: '/tmp/sample.pdf',
            documentBackend: 'electron',
            documentInstanceId: 'instance-1',
            documentRevisionToken: 'revision-token-1',
        }}));
        expect(mocks.transfer).toHaveBeenCalledWith(expect.objectContaining({tab: expect.objectContaining({
            originalBackend: 'electron',
            documentInstanceId: 'instance-1',
        })}));
    });

    it('does not close the source tab when its document instance changes before transfer acknowledgement', async () => {
        const payload = createPayload();
        const tab = {
            id: 'tab-1',
            fileName: 'sample.pdf',
            originalPath: '/tmp/sample.pdf',
            isDirty: true,
            isDjvu: false,
        };
        const pane = {
            paneId: 'pane-1',
            activeTabId: 'tab-1',
            tabIds: ['tab-1'],
        };
        const workspace = cast<IWorkspaceExpose>({
            hasPdf: true,
            captureSplitPayload: vi.fn(async () => payload),
            handleCloseFileFromUi: vi.fn(async () => true),
        });
        let nextInstanceId = 0;
        const documentIdentity = {
            version: 1,
            authority: 'browser-document-store',
            contentRevision: 4,
            documentRef: '/tmp/sample.pdf',
            mintedAt: 123,
            token: 'revision-token-1',
        } as const;
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
            createDocumentInstanceId: () => {
                nextInstanceId += 1;
                return `instance-${nextInstanceId}`;
            },
            initialRecord: createWorkspaceDocumentRecord({
                tab,
                documentIdentity,
            }),
        });
        const closeTabInState = vi.fn();
        const handoffActiveTabBeforeClose = vi.fn();
        mocks.transfer.mockImplementationOnce(async () => {
            const reopen = session.beginTransaction({
                kind: 'open',
                documentRef: '/tmp/sample.pdf',
            });
            session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
                tab,
                documentIdentity,
            }), 'workspace');
            session.finishTransaction(reopen.id, 'committed');
            return {
                transferId: 'transfer-1',
                success: true,
                targetWindowId: 2,
            };
        });

        const transfers = useWindowTabTransfers({
            activePaneId: ref('pane-1'),
            panes: ref([pane]),
            tabs: ref([tab]),
            layout: ref(null),
            createTab: vi.fn(),
            getPaneById: vi.fn((paneId: string | null | undefined) => paneId === 'pane-1' ? pane : null),
            getTabById: vi.fn((tabId: string | null | undefined) => tabId === 'tab-1' ? tab : null),
            getPaneByTabId: vi.fn((tabId: string) => tabId === 'tab-1' ? pane : null),
            activatePane: vi.fn(),
            activateTab: vi.fn(),
            removeTabFromState: vi.fn(),
            updateTab: vi.fn(),
            cleanupEmptyPanes: vi.fn(),
            closeTabInState,
            workspaceRefs: ref(new Map<string, IWorkspaceExpose>([[
                'tab-1',
                workspace,
            ]])),
            documentSessionsByTabId: shallowRef({'tab-1': session}),
            waitForWorkspace: vi.fn(async (tabId: string): Promise<IWorkspaceExpose | null> => tabId === 'tab-1' ? workspace : null),
            workspaceRestoreTracker: {
                start: vi.fn(),
                finish: vi.fn(),
            },
            handleCloseTab: vi.fn(),
            handoffActiveTabBeforeClose,
        });

        await transfers.moveTabToWindow(2, 'tab-1');

        expect(mocks.transfer).toHaveBeenCalledWith(expect.objectContaining({session: expect.objectContaining({
            documentInstanceId: 'instance-1',
            documentRevisionToken: 'revision-token-1',
        })}));
        expect(workspace.handleCloseFileFromUi).not.toHaveBeenCalled();
        expect(handoffActiveTabBeforeClose).not.toHaveBeenCalled();
        expect(closeTabInState).not.toHaveBeenCalled();
    });

    it('activates created incoming transfer tabs before restoring their workspace payload', async () => {
        const payload = createPayload();
        const existingTab: ITab = {
            id: 'tab-existing',
            fileName: 'existing.pdf',
            originalPath: '/tmp/existing.pdf',
            isDirty: false,
            isDjvu: false,
        };
        const pane = {
            paneId: 'pane-1',
            activeTabId: 'tab-existing',
            tabIds: ['tab-existing'],
        };
        const tabsState = ref<ITab[]>([existingTab]);
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const restoredWorkspace = cast<IWorkspaceExpose>({
            hasPdf: true,
            restoreSplitPayload: vi.fn(async () => undefined),
        });
        const existingWorkspace = cast<IWorkspaceExpose>({ hasPdf: true });
        workspaceRefs.value.set('tab-existing', existingWorkspace);
        let destinationMounted = false;
        const createTab = vi.fn((options: {
            paneId?: string;
            activate?: boolean;
        }) => {
            expect(options.activate).toBe(true);
            const tab = {
                id: 'tab-created',
                fileName: null,
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            };
            tabsState.value = [
                ...tabsState.value,
                tab,
            ];
            pane.tabIds.push(tab.id);
            if (options.activate !== false) {
                pane.activeTabId = tab.id;
                destinationMounted = true;
                workspaceRefs.value.set(tab.id, restoredWorkspace);
            }
            return tab;
        });
        const waitForWorkspace = vi.fn(async (tabId: string): Promise<IWorkspaceExpose | null> => (
            destinationMounted && tabId === 'tab-created'
                ? restoredWorkspace
                : null
        ));

        const transfers = useWindowTabTransfers({
            activePaneId: ref('pane-1'),
            panes: ref([pane]),
            tabs: tabsState,
            layout: ref(null),
            createTab,
            getPaneById: vi.fn((paneId: string | null | undefined) => paneId === 'pane-1' ? pane : null),
            getTabById: vi.fn((tabId: string | null | undefined) => tabsState.value.find(tab => tab.id === tabId) ?? null),
            getPaneByTabId: vi.fn((tabId: string) => pane.tabIds.includes(tabId) ? pane : null),
            activatePane: vi.fn(),
            activateTab: vi.fn((paneId: string, tabId: string) => {
                if (paneId === pane.paneId) {
                    pane.activeTabId = tabId;
                }
            }),
            removeTabFromState: vi.fn(),
            updateTab: vi.fn(),
            cleanupEmptyPanes: vi.fn(),
            closeTabInState: vi.fn(),
            workspaceRefs,
            waitForWorkspace,
            workspaceRestoreTracker: {
                start: vi.fn(),
                finish: vi.fn(),
            },
            handleCloseTab: vi.fn(),
            handoffActiveTabBeforeClose: vi.fn(),
        });

        await transfers.handleIncomingTabTransfer({
            transferId: 'transfer-1',
            sourceWindowId: 1,
            targetWindowId: 2,
            tab: {
                fileName: 'sample.pdf',
                originalPath: '/tmp/sample.pdf',
                isDirty: true,
                isDjvu: false,
            },
            payload,
        });

        expect(createTab).toHaveBeenCalledWith({
            paneId: 'pane-1',
            activate: true,
        });
        expect(restoredWorkspace.restoreSplitPayload).toHaveBeenCalledWith(payload);
        expect(mocks.transferAck).toHaveBeenCalledWith({
            transferId: 'transfer-1',
            success: true,
        });
    });

    it('rejects incoming transfers when the restored document instance differs from the transfer session', async () => {
        const payload = createPayload();
        const existingTab: ITab = {
            id: 'tab-existing',
            fileName: 'existing.pdf',
            originalPath: '/tmp/existing.pdf',
            isDirty: false,
            isDjvu: false,
        };
        const pane = {
            paneId: 'pane-1',
            activeTabId: 'tab-existing',
            tabIds: ['tab-existing'],
        };
        const tabsState = ref<ITab[]>([existingTab]);
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const documentSessionsByTabId = shallowRef<Record<string, ReturnType<typeof createWorkspaceDocumentSessionCore>>>({});
        const restoredWorkspace = cast<IWorkspaceExpose>({
            hasPdf: true,
            restoreSplitPayload: vi.fn(async () => undefined),
        });
        workspaceRefs.value.set('tab-existing', cast<IWorkspaceExpose>({ hasPdf: true }));
        let destinationMounted = false;
        const removeTabFromState = vi.fn();
        const createTab = vi.fn(() => {
            const tab: ITab = {
                id: 'tab-created',
                fileName: null,
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            };
            tabsState.value = [
                ...tabsState.value,
                tab,
            ];
            pane.tabIds.push(tab.id);
            pane.activeTabId = tab.id;
            destinationMounted = true;
            workspaceRefs.value.set(tab.id, restoredWorkspace);
            const targetSession = createWorkspaceDocumentSessionCore({
                tabId: tab.id,
                sessionId: 'session-target',
                createDocumentInstanceId: () => 'instance-b',
                initialRecord: createWorkspaceDocumentRecord({
                    tab: {
                        ...tab,
                        fileName: 'sample.pdf',
                        originalPath: '/tmp/sample.pdf',
                    },
                    documentIdentity: {
                        version: 1,
                        authority: 'browser-document-store',
                        contentRevision: 4,
                        documentRef: '/tmp/sample.pdf',
                        mintedAt: 123,
                        token: 'revision-token-1',
                    },
                }),
            });
            documentSessionsByTabId.value = {[tab.id]: targetSession};
            return tab;
        });

        const transfers = useWindowTabTransfers({
            activePaneId: ref('pane-1'),
            panes: ref([pane]),
            tabs: tabsState,
            layout: ref(null),
            createTab,
            getPaneById: vi.fn((paneId: string | null | undefined) => paneId === 'pane-1' ? pane : null),
            getTabById: vi.fn((tabId: string | null | undefined) => tabsState.value.find(tab => tab.id === tabId) ?? null),
            getPaneByTabId: vi.fn((tabId: string) => pane.tabIds.includes(tabId) ? pane : null),
            activatePane: vi.fn(),
            activateTab: vi.fn((paneId: string, tabId: string) => {
                if (paneId === pane.paneId) {
                    pane.activeTabId = tabId;
                }
            }),
            removeTabFromState,
            updateTab: vi.fn(),
            cleanupEmptyPanes: vi.fn(),
            closeTabInState: vi.fn(),
            workspaceRefs,
            documentSessionsByTabId,
            waitForWorkspace: vi.fn(async (tabId: string): Promise<IWorkspaceExpose | null> => (
                destinationMounted && tabId === 'tab-created'
                    ? restoredWorkspace
                    : null
            )),
            workspaceRestoreTracker: {
                start: vi.fn(),
                finish: vi.fn(),
            },
            handleCloseTab: vi.fn(),
            handoffActiveTabBeforeClose: vi.fn(),
        });

        await transfers.handleIncomingTabTransfer({
            transferId: 'transfer-1',
            sourceWindowId: 1,
            targetWindowId: 2,
            tab: {
                fileName: 'sample.pdf',
                originalPath: '/tmp/sample.pdf',
                documentInstanceId: 'instance-a',
                isDirty: true,
                isDjvu: false,
            },
            payload,
            session: {
                sessionId: 'session-source',
                sessionRevision: 0,
                documentRef: '/tmp/sample.pdf',
                documentInstanceId: 'instance-a',
                documentRevisionToken: 'revision-token-1',
            },
        });

        expect(restoredWorkspace.restoreSplitPayload).toHaveBeenCalledWith(payload);
        expect(removeTabFromState).toHaveBeenCalledWith('tab-created');
        expect(mocks.transferAck).toHaveBeenCalledWith({
            transferId: 'transfer-1',
            success: false,
            error: 'tabs.transferErrors.restoreFailed',
        });
    });

    it('rolls back reused target tabs when the success ack is rejected', async () => {
        const payload = createPayload();
        const placeholderTab: ITab = {
            id: 'tab-placeholder',
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        };
        const pane = {
            paneId: 'pane-1',
            activeTabId: 'tab-placeholder',
            tabIds: ['tab-placeholder'],
        };
        const restoredWorkspace = cast<IWorkspaceExpose>({
            hasPdf: true,
            restoreSplitPayload: vi.fn(async () => undefined),
        });
        const updateTab = vi.fn();
        const activatePane = vi.fn();
        const activateTab = vi.fn();
        mocks.transferAck.mockResolvedValueOnce(false);

        const transfers = useWindowTabTransfers({
            activePaneId: ref('pane-1'),
            panes: ref([pane]),
            tabs: ref([placeholderTab]),
            layout: ref(null),
            createTab: vi.fn(),
            getPaneById: vi.fn((paneId: string | null | undefined) => {
                if (paneId === 'pane-1') {
                    return pane;
                }
                return null;
            }),
            getTabById: vi.fn((tabId: string | null | undefined) => {
                if (tabId === placeholderTab.id) {
                    return placeholderTab;
                }
                return null;
            }),
            getPaneByTabId: vi.fn((tabId: string) => tabId === placeholderTab.id ? pane : null),
            activatePane,
            activateTab,
            removeTabFromState: vi.fn(),
            updateTab,
            cleanupEmptyPanes: vi.fn(),
            closeTabInState: vi.fn(),
            workspaceRefs: ref(new Map<string, IWorkspaceExpose>()),
            waitForWorkspace: vi.fn(async (tabId: string): Promise<IWorkspaceExpose | null> => (
                tabId === placeholderTab.id ? restoredWorkspace : null
            )),
            workspaceRestoreTracker: {
                start: vi.fn(),
                finish: vi.fn(),
            },
            handleCloseTab: vi.fn(),
            handoffActiveTabBeforeClose: vi.fn(),
        });

        await transfers.handleIncomingTabTransfer({
            transferId: 'transfer-ack-failed',
            sourceWindowId: 1,
            targetWindowId: 2,
            tab: {
                fileName: 'sample.pdf',
                originalPath: '/tmp/sample.pdf',
                isDirty: true,
                isDjvu: false,
            },
            payload,
        });

        expect(updateTab).toHaveBeenCalledWith('tab-placeholder', {
            fileName: null,
            originalPath: null,
            documentInstanceId: null,
            isDirty: false,
            isDjvu: false,
        });
        expect(activateTab).toHaveBeenCalledWith('pane-1', 'tab-placeholder');
        expect(mocks.cleanupSplitPayloadSnapshot).toHaveBeenCalledWith(payload, {
            logSection: 'tabs',
            context: 'rollback-incoming-transfer-tab',
            metadata: { tabId: 'tab-placeholder' },
        });
    });
});
