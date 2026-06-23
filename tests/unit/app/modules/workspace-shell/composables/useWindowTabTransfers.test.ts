import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { TSplitPayload } from '@contracts/windowTabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { useWindowTabTransfers } from '@app/modules/workspace-shell/composables/useWindowTabTransfers';
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
});
