import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
} from 'vue';
import type { TSplitPayload } from '@contracts/windowTabs';
import { useAppShellDirectionalTabs } from '@app/modules/workspace-shell/composables/useAppShellDirectionalTabs';
import type { ITab } from '@app/types/tabs';

const mocks = vi.hoisted(() => ({ createWorkingCopyFromPath: vi.fn() }));

vi.mock('@app/utils/platformDocuments', () => ({ getDocumentsCapability: () => ({ createWorkingCopyFromPath: mocks.createWorkingCopyFromPath }) }));

function createPayload(): TSplitPayload {
    return {
        kind: 'pdfSnapshot',
        fileName: 'sample.pdf',
        originalPath: '/tmp/sample.pdf',
        snapshotPath: '/tmp/snapshot.pdf',
        isDirty: true,
    };
}

describe('useAppShellDirectionalTabs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('does not create a split pane when independent payload preparation fails', async () => {
        const sourcePane = {
            paneId: 'pane-1',
            activeTabId: 'tab-1',
            tabIds: ['tab-1'],
        };
        const sourceTab = {
            id: 'tab-1',
            fileName: 'sample.pdf',
            originalPath: '/tmp/sample.pdf',
            isDirty: true,
            isDjvu: false,
        };
        const splitPane = vi.fn(() => 'pane-2');
        const createTab = vi.fn();
        mocks.createWorkingCopyFromPath.mockRejectedValueOnce(new Error('copy failed'));

        const tabs = useAppShellDirectionalTabs({
            activePaneId: ref('pane-1'),
            panes: ref([sourcePane]),
            tabs: ref([sourceTab]),
            workspaceRefs: ref(new Map()),
            isTabTransitionBusy: computed(() => false),
            getPaneById: vi.fn((paneId: string | null | undefined) => paneId === 'pane-1' ? sourcePane : null),
            getTabById: vi.fn((tabId: string | null | undefined) => tabId === 'tab-1' ? sourceTab : null),
            findDirectionalPane: vi.fn(() => null),
            focusPane: vi.fn(),
            splitPane,
            moveTabToPane: vi.fn(),
            createTab,
            activatePane: vi.fn(),
            activateTab: vi.fn(),
            removeTabFromState: vi.fn(),
            cleanupEmptyPanes: vi.fn(),
            workspaceSplitCache: {
                clear: vi.fn(),
                consume: vi.fn(),
                has: vi.fn(),
                peek: vi.fn(),
                set: vi.fn(() => 'cache-entry'),
            },
            isSingletonPlaceholderCloseBlocked: vi.fn(() => false),
            enqueueTabTransition: vi.fn(async task => task()),
            captureWorkspacePayload: vi.fn(async () => createPayload()),
            restoreWorkspacePayload: vi.fn(),
            moveTabToNewWindow: vi.fn(),
            moveTabToWindow: vi.fn(),
            handleCloseTab: vi.fn(),
        });

        await expect(tabs.splitEditor('right')).rejects.toThrow('copy failed');
        expect(splitPane).not.toHaveBeenCalled();
        expect(createTab).not.toHaveBeenCalled();
    });

    it('activates copied destination tabs before restoring their workspace payload', async () => {
        const sourcePane = {
            paneId: 'pane-1',
            activeTabId: 'tab-1',
            tabIds: ['tab-1'],
        };
        const targetPane = {
            paneId: 'pane-2',
            activeTabId: 'tab-2',
            tabIds: ['tab-2'],
        };
        const sourceTab: ITab = {
            id: 'tab-1',
            fileName: 'sample.pdf',
            originalPath: '/tmp/sample.pdf',
            isDirty: true,
            isDjvu: false,
        };
        const targetTab: ITab = {
            id: 'tab-2',
            fileName: 'target.pdf',
            originalPath: '/tmp/target.pdf',
            isDirty: false,
            isDjvu: false,
        };
        const tabsState = ref<ITab[]>([
            sourceTab,
            targetTab,
        ]);
        let destinationMounted = false;
        const createTab = vi.fn((options: {
            paneId?: string | null;
            activate?: boolean;
            initial?: Partial<ITab>;
        }) => {
            expect(options.activate).toBe(true);
            const tab: ITab = {
                id: 'tab-copy',
                fileName: options.initial?.fileName ?? null,
                originalPath: options.initial?.originalPath ?? null,
                isDirty: options.initial?.isDirty ?? false,
                isDjvu: options.initial?.isDjvu ?? false,
            };
            tabsState.value = [
                ...tabsState.value,
                tab,
            ];
            targetPane.tabIds.push(tab.id);
            if (options.activate !== false) {
                targetPane.activeTabId = tab.id;
                destinationMounted = true;
            }
            return tab;
        });
        const restoreWorkspacePayload = vi.fn(async () => destinationMounted);

        const directionalTabs = useAppShellDirectionalTabs({
            activePaneId: ref('pane-1'),
            panes: ref([
                sourcePane,
                targetPane,
            ]),
            tabs: tabsState,
            workspaceRefs: ref(new Map()),
            isTabTransitionBusy: computed(() => false),
            getPaneById: vi.fn((paneId: string | null | undefined) => {
                return [
                    sourcePane,
                    targetPane,
                ].find(pane => pane.paneId === paneId) ?? null;
            }),
            getTabById: vi.fn((tabId: string | null | undefined) => tabsState.value.find(tab => tab.id === tabId) ?? null),
            findDirectionalPane: vi.fn((_paneId: string, direction: string) => direction === 'right' ? targetPane : null),
            focusPane: vi.fn(),
            splitPane: vi.fn(),
            moveTabToPane: vi.fn(),
            createTab,
            activatePane: vi.fn(),
            activateTab: vi.fn(),
            removeTabFromState: vi.fn(),
            cleanupEmptyPanes: vi.fn(),
            workspaceSplitCache: {
                clear: vi.fn(),
                consume: vi.fn(),
                has: vi.fn(),
                peek: vi.fn(),
                set: vi.fn(() => 'cache-entry'),
            },
            isSingletonPlaceholderCloseBlocked: vi.fn(() => false),
            enqueueTabTransition: vi.fn(async task => task()),
            captureWorkspacePayload: vi.fn(async () => createPayload()),
            restoreWorkspacePayload,
            moveTabToNewWindow: vi.fn(),
            moveTabToWindow: vi.fn(),
            handleCloseTab: vi.fn(),
        });

        await directionalTabs.copyActiveTab('right');

        expect(createTab).toHaveBeenCalledWith(expect.objectContaining({
            paneId: 'pane-2',
            activate: true,
        }));
        expect(restoreWorkspacePayload).toHaveBeenCalledWith('tab-copy', createPayload());
    });

    it('gates existing-window transfer availability while tab transitions are busy', () => {
        vi.stubGlobal('window', { electronAPI: {} });
        const pane = {
            paneId: 'pane-1',
            activeTabId: 'tab-1',
            tabIds: ['tab-1'],
        };
        const tab: ITab = {
            id: 'tab-1',
            fileName: 'sample.pdf',
            originalPath: '/tmp/sample.pdf',
            isDirty: false,
            isDjvu: false,
        };
        const isTabTransitionBusy = ref(true);

        const directionalTabs = useAppShellDirectionalTabs({
            activePaneId: ref('pane-1'),
            panes: ref([pane]),
            tabs: ref([tab]),
            workspaceRefs: ref(new Map()),
            isTabTransitionBusy: computed(() => isTabTransitionBusy.value),
            getPaneById: vi.fn((paneId: string | null | undefined) => paneId === pane.paneId ? pane : null),
            getTabById: vi.fn((tabId: string | null | undefined) => tabId === tab.id ? tab : null),
            findDirectionalPane: vi.fn(() => null),
            focusPane: vi.fn(),
            splitPane: vi.fn(),
            moveTabToPane: vi.fn(),
            createTab: vi.fn(),
            activatePane: vi.fn(),
            activateTab: vi.fn(),
            removeTabFromState: vi.fn(),
            cleanupEmptyPanes: vi.fn(),
            workspaceSplitCache: {
                clear: vi.fn(),
                consume: vi.fn(),
                has: vi.fn(),
                peek: vi.fn(),
                set: vi.fn(() => 'cache-entry'),
            },
            isSingletonPlaceholderCloseBlocked: vi.fn(() => false),
            enqueueTabTransition: vi.fn(async task => task()),
            captureWorkspacePayload: vi.fn(async () => createPayload()),
            restoreWorkspacePayload: vi.fn(),
            moveTabToNewWindow: vi.fn(),
            moveTabToWindow: vi.fn(),
            handleCloseTab: vi.fn(),
        });

        expect(directionalTabs.tabContextAvailabilityByPane.value['pane-1']?.canMoveToWindow).toBe(false);

        isTabTransitionBusy.value = false;

        expect(directionalTabs.tabContextAvailabilityByPane.value['pane-1']?.canMoveToWindow).toBe(true);
    });

    it('queues existing-window tab transfers through the tab transition queue', async () => {
        const pane = {
            paneId: 'pane-1',
            activeTabId: 'tab-1',
            tabIds: ['tab-1'],
        };
        const tab: ITab = {
            id: 'tab-1',
            fileName: 'sample.pdf',
            originalPath: '/tmp/sample.pdf',
            isDirty: false,
            isDjvu: false,
        };
        const enqueueTabTransition = vi.fn(async task => task());
        const moveTabToWindow = vi.fn(async () => {});

        const directionalTabs = useAppShellDirectionalTabs({
            activePaneId: ref('pane-1'),
            panes: ref([pane]),
            tabs: ref([tab]),
            workspaceRefs: ref(new Map()),
            isTabTransitionBusy: computed(() => false),
            getPaneById: vi.fn((paneId: string | null | undefined) => paneId === pane.paneId ? pane : null),
            getTabById: vi.fn((tabId: string | null | undefined) => tabId === tab.id ? tab : null),
            findDirectionalPane: vi.fn(() => null),
            focusPane: vi.fn(),
            splitPane: vi.fn(),
            moveTabToPane: vi.fn(),
            createTab: vi.fn(),
            activatePane: vi.fn(),
            activateTab: vi.fn(),
            removeTabFromState: vi.fn(),
            cleanupEmptyPanes: vi.fn(),
            workspaceSplitCache: {
                clear: vi.fn(),
                consume: vi.fn(),
                has: vi.fn(),
                peek: vi.fn(),
                set: vi.fn(() => 'cache-entry'),
            },
            isSingletonPlaceholderCloseBlocked: vi.fn(() => false),
            enqueueTabTransition,
            captureWorkspacePayload: vi.fn(async () => createPayload()),
            restoreWorkspacePayload: vi.fn(),
            moveTabToNewWindow: vi.fn(),
            moveTabToWindow,
            handleCloseTab: vi.fn(),
        });

        await directionalTabs.handleTabContextCommand('pane-1', 'tab-1', {
            kind: 'move-to-window',
            targetWindowId: 42,
        });

        expect(enqueueTabTransition).toHaveBeenCalledOnce();
        expect(moveTabToWindow).toHaveBeenCalledWith(42, 'tab-1');
    });
});
