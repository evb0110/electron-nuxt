import {
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
});
