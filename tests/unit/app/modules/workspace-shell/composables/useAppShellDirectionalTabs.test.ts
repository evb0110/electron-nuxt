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
    shallowRef,
} from 'vue';
import type { TSplitPayload } from '@contracts/windowTabs';
import { useAppShellDirectionalTabs } from '@app/modules/workspace-shell/composables/useAppShellDirectionalTabs';
import { createWorkspaceDocumentSessionCore } from '@app/modules/workspace-shell/document-sessions/createWorkspaceDocumentSessionCore';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import type { ITab } from '@app/types/tabs';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

const mocks = vi.hoisted(() => ({
    createWorkingCopyFromPath: vi.fn(),
    legacyCreateWorkingCopyFromPath: vi.fn(() => {
        throw new Error('legacy createWorkingCopyFromPath should not be used');
    }),
}));

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentWorkingCopyCapability: () => ({ createWorkingCopyFromPath: mocks.createWorkingCopyFromPath }),
    getDocumentsCapability: () => ({ createWorkingCopyFromPath: mocks.legacyCreateWorkingCopyFromPath }),
}));

function createPayload(): TSplitPayload {
    return {
        kind: 'pdfSnapshot',
        fileName: 'sample.pdf',
        originalPath: '/tmp/sample.pdf',
        snapshotPath: '/tmp/snapshot.pdf',
        isDirty: true,
    };
}

function createCloseHarness(pane: {
    paneId: string;
    activeTabId: string;
    tabIds: string[];
}, handleCloseTab: (paneId: string, tabId: string) => Promise<void>) {
    return useAppShellDirectionalTabs({
        activePaneId: ref(pane.paneId),
        panes: ref([pane]),
        tabs: ref(pane.tabIds.map(id => ({
            id,
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        }))),
        workspaceRefs: ref(new Map()),
        getDocumentRecord: vi.fn(() => null),
        isTabTransitionBusy: computed(() => false),
        getPaneById: vi.fn((paneId: string | null | undefined) => paneId === pane.paneId ? pane : null),
        getTabById: vi.fn(() => null),
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
        handleCloseTab,
    });
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
            getDocumentRecord: vi.fn(() => null),
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
        expect(mocks.createWorkingCopyFromPath).toHaveBeenCalledWith('/tmp/snapshot.pdf', '/tmp/sample.pdf');
        expect(mocks.legacyCreateWorkingCopyFromPath).not.toHaveBeenCalled();
        expect(splitPane).not.toHaveBeenCalled();
        expect(createTab).not.toHaveBeenCalled();
    });

    it('tags split cache entries with the source tab session snapshot', async () => {
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
        const session = createWorkspaceDocumentSessionCore({
            tabId: 'tab-1',
            sessionId: 'session-1',
            initialRecord: createWorkspaceDocumentRecord({tab: {
                fileName: sourceTab.fileName,
                originalPath: sourceTab.originalPath,
                isDirty: sourceTab.isDirty,
                isDjvu: sourceTab.isDjvu,
            }}),
        });
        const workspaceSplitCacheSet = vi.fn(() => 'cache-entry');
        mocks.createWorkingCopyFromPath.mockResolvedValueOnce('/tmp/snapshot-copy.pdf');

        const tabs = useAppShellDirectionalTabs({
            activePaneId: ref('pane-1'),
            panes: ref([sourcePane]),
            tabs: ref([sourceTab]),
            workspaceRefs: ref(new Map()),
            documentSessionsByTabId: shallowRef({'tab-1': session}),
            getDocumentRecord: vi.fn(() => null),
            isTabTransitionBusy: computed(() => false),
            getPaneById: vi.fn((paneId: string | null | undefined) => paneId === 'pane-1' ? sourcePane : null),
            getTabById: vi.fn((tabId: string | null | undefined) => tabId === 'tab-1' ? sourceTab : null),
            findDirectionalPane: vi.fn(() => null),
            focusPane: vi.fn(),
            splitPane: vi.fn(() => 'pane-2'),
            moveTabToPane: vi.fn(),
            createTab: vi.fn(() => ({
                id: 'tab-2',
                fileName: null,
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            })),
            activatePane: vi.fn(),
            activateTab: vi.fn(),
            removeTabFromState: vi.fn(),
            cleanupEmptyPanes: vi.fn(),
            workspaceSplitCache: {
                clear: vi.fn(),
                consume: vi.fn(),
                has: vi.fn(),
                peek: vi.fn(),
                set: workspaceSplitCacheSet,
            },
            isSingletonPlaceholderCloseBlocked: vi.fn(() => false),
            enqueueTabTransition: vi.fn(async task => task()),
            captureWorkspacePayload: vi.fn(async () => createPayload()),
            restoreWorkspacePayload: vi.fn(async () => true),
            moveTabToNewWindow: vi.fn(),
            moveTabToWindow: vi.fn(),
            handleCloseTab: vi.fn(),
        });

        await tabs.splitEditor('right');

        expect(workspaceSplitCacheSet).toHaveBeenCalledWith(
            'tab-1',
            expect.objectContaining({kind: 'pdfSnapshot'}),
            {session: expect.objectContaining({
                sessionId: 'session-1',
                sessionRevision: 0,
                documentRef: '/tmp/sample.pdf',
            })},
        );
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
            getDocumentRecord: vi.fn(() => null),
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
        vi.stubGlobal('window', { electronAPI: createElectronPlatformApiFixture() });
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
            getDocumentRecord: vi.fn(() => null),
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
            getDocumentRecord: vi.fn(() => null),
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

    it('closes every other tab in the pane while keeping the target tab', async () => {
        const handleCloseTab = vi.fn(async () => {});
        const directionalTabs = createCloseHarness({
            paneId: 'pane-1',
            activeTabId: 'tab-2',
            tabIds: [
                'tab-1',
                'tab-2',
                'tab-3',
            ],
        }, handleCloseTab);

        await directionalTabs.handleTabContextCommand('pane-1', 'tab-2', { kind: 'close-others' });

        expect(handleCloseTab).toHaveBeenCalledTimes(2);
        expect(handleCloseTab).toHaveBeenNthCalledWith(1, 'pane-1', 'tab-1');
        expect(handleCloseTab).toHaveBeenNthCalledWith(2, 'pane-1', 'tab-3');
        expect(handleCloseTab).not.toHaveBeenCalledWith('pane-1', 'tab-2');
    });

    it('closes only the tabs to the right of the target tab', async () => {
        const handleCloseTab = vi.fn(async () => {});
        const directionalTabs = createCloseHarness({
            paneId: 'pane-1',
            activeTabId: 'tab-1',
            tabIds: [
                'tab-1',
                'tab-2',
                'tab-3',
            ],
        }, handleCloseTab);

        await directionalTabs.handleTabContextCommand('pane-1', 'tab-1', { kind: 'close-right' });

        expect(handleCloseTab).toHaveBeenCalledTimes(2);
        expect(handleCloseTab).toHaveBeenNthCalledWith(1, 'pane-1', 'tab-2');
        expect(handleCloseTab).toHaveBeenNthCalledWith(2, 'pane-1', 'tab-3');
    });

    it('keeps new-tab creation available even while a tab transition is in flight', () => {
        const pane = {
            paneId: 'pane-1',
            activeTabId: 'tab-1',
            tabIds: ['tab-1'],
        };
        const handleCloseTab = vi.fn(async () => {});
        const isTabTransitionBusy = ref(true);
        const directionalTabs = useAppShellDirectionalTabs({
            activePaneId: ref('pane-1'),
            panes: ref([pane]),
            tabs: ref([]),
            workspaceRefs: ref(new Map()),
            getDocumentRecord: vi.fn(() => null),
            isTabTransitionBusy: computed(() => isTabTransitionBusy.value),
            getPaneById: vi.fn((paneId: string | null | undefined) => paneId === pane.paneId ? pane : null),
            getTabById: vi.fn(() => null),
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
            handleCloseTab,
        });

        expect(directionalTabs.tabContextAvailabilityByPane.value['pane-1']?.canCreate).toBe(true);

        isTabTransitionBusy.value = false;

        expect(directionalTabs.tabContextAvailabilityByPane.value['pane-1']?.canCreate).toBe(true);
    });

    it('moves the active tab without split payload capture or eager source activation', async () => {
        const sourcePane = {
            paneId: 'pane-1',
            activeTabId: 'tab-1',
            tabIds: [
                'tab-1',
                'tab-2',
            ],
        };
        const targetPane = {
            paneId: 'pane-2',
            activeTabId: 'tab-3',
            tabIds: ['tab-3'],
        };
        const activateTab = vi.fn();
        const moveTabToPane = vi.fn(() => true);
        const captureWorkspacePayload = vi.fn(async () => createPayload());
        const workspaceSplitCacheSet = vi.fn(() => 'cache-entry');

        const directionalTabs = useAppShellDirectionalTabs({
            activePaneId: ref('pane-1'),
            panes: ref([
                sourcePane,
                targetPane,
            ]),
            tabs: ref([]),
            workspaceRefs: ref(new Map()),
            getDocumentRecord: vi.fn(() => null),
            isTabTransitionBusy: computed(() => false),
            getPaneById: vi.fn((paneId: string | null | undefined) => [
                sourcePane,
                targetPane,
            ].find(pane => pane.paneId === paneId) ?? null),
            getTabById: vi.fn(() => null),
            findDirectionalPane: vi.fn((_paneId: string, direction: string) => direction === 'right' ? targetPane : null),
            focusPane: vi.fn(),
            splitPane: vi.fn(),
            moveTabToPane,
            createTab: vi.fn(),
            activatePane: vi.fn(),
            activateTab,
            removeTabFromState: vi.fn(),
            cleanupEmptyPanes: vi.fn(),
            workspaceSplitCache: {
                clear: vi.fn(),
                consume: vi.fn(),
                has: vi.fn(),
                peek: vi.fn(),
                set: workspaceSplitCacheSet,
            },
            isSingletonPlaceholderCloseBlocked: vi.fn(() => false),
            enqueueTabTransition: vi.fn(async task => task()),
            captureWorkspacePayload,
            restoreWorkspacePayload: vi.fn(),
            moveTabToNewWindow: vi.fn(),
            moveTabToWindow: vi.fn(),
            handleCloseTab: vi.fn(),
        });

        await directionalTabs.moveActiveTab('right', 0);

        expect(moveTabToPane).toHaveBeenCalledWith('tab-1', 'pane-2', true, 0);
        expect(activateTab).not.toHaveBeenCalled();
        expect(captureWorkspacePayload).not.toHaveBeenCalled();
        expect(workspaceSplitCacheSet).not.toHaveBeenCalled();
    });
});
