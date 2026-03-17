import {
    computed,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IWorkspaceExpose } from '@app/types/workspace-expose';
import type { ITab } from '@app/types/tabs';
import { useAppShellWorkspaceRouting } from '@app/modules/workspace-shell/composables/useAppShellWorkspaceRouting';

function cast<T>(value: unknown): T {
    return value as T;
}

interface IWorkspaceRecord {
    workspace: IWorkspaceExpose;
    openPath: ReturnType<typeof vi.fn>;
    openResult: ReturnType<typeof vi.fn>;
}

function createTabStub(id: string): ITab {
    return {
        id,
        fileName: null,
        originalPath: null,
        isDirty: false,
        isDjvu: false,
    };
}

function createWorkspace(hasPdf = false): IWorkspaceRecord {
    const state = ref(hasPdf);
    const openPath = vi.fn(async (_path: string) => {
        state.value = true;
    });
    const openResult = vi.fn(async (_result: unknown) => {
        state.value = true;
    });

    return {
        openPath,
        openResult,
        workspace: cast<IWorkspaceExpose>({
            hasPdf: state,
            handleOpenFileDirectWithPersist: openPath,
            handleOpenFileWithResult: openResult,
        }),
    };
}

describe('useAppShellWorkspaceRouting', () => {
    it('opens each external path in its own tab instead of batching them into one workspace', async () => {
        const activeGroupId = ref('group-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(true);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();

        const routing = useAppShellWorkspaceRouting({
            activeGroupId,
            activeTabId,
            activeWorkspace: computed(() => workspaceRefs.value.get(activeTabId.value ?? '') ?? null),
            workspaceRefs,
            waitForWorkspace: vi.fn(async (tabId: string) => workspaceRefs.value.get(tabId) ?? null),
            createTab: vi.fn(({ activate }: { activate?: boolean } = {}) => {
                createdCount += 1;
                const tabId = `tab-${createdCount}`;
                const record = createWorkspace(false);
                createdWorkspaces.set(tabId, record);
                workspaceRefs.value.set(tabId, record.workspace);
                if (activate !== false) {
                    activeTabId.value = tabId;
                }
                return createTabStub(tabId);
            }),
            removeTabFromState: vi.fn(),
            resolveTabForAction: vi.fn(() => null),
            handleCloseTab: vi.fn(async () => {}),
            moveTabToNewWindow: vi.fn(async () => {}),
            moveTabToWindow: vi.fn(async () => {}),
            mergeWindowInto: vi.fn(async () => {}),
        });

        await routing.openPathsInAppropriateTab([
            '/docs/first.pdf',
            '/docs/second.pdf',
        ]);

        expect(initialWorkspace.openPath).not.toHaveBeenCalled();
        expect(createdWorkspaces.get('tab-2')?.openPath).toHaveBeenCalledWith('/docs/first.pdf');
        expect(createdWorkspaces.get('tab-3')?.openPath).toHaveBeenCalledWith('/docs/second.pdf');
    });

    it('reuses the placeholder tab for the first path, then opens later paths in new tabs', async () => {
        const activeGroupId = ref('group-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(false);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();

        const routing = useAppShellWorkspaceRouting({
            activeGroupId,
            activeTabId,
            activeWorkspace: computed(() => workspaceRefs.value.get(activeTabId.value ?? '') ?? null),
            workspaceRefs,
            waitForWorkspace: vi.fn(async (tabId: string) => workspaceRefs.value.get(tabId) ?? null),
            createTab: vi.fn(({ activate }: { activate?: boolean } = {}) => {
                createdCount += 1;
                const tabId = `tab-${createdCount}`;
                const record = createWorkspace(false);
                createdWorkspaces.set(tabId, record);
                workspaceRefs.value.set(tabId, record.workspace);
                if (activate !== false) {
                    activeTabId.value = tabId;
                }
                return createTabStub(tabId);
            }),
            removeTabFromState: vi.fn(),
            resolveTabForAction: vi.fn(() => null),
            handleCloseTab: vi.fn(async () => {}),
            moveTabToNewWindow: vi.fn(async () => {}),
            moveTabToWindow: vi.fn(async () => {}),
            mergeWindowInto: vi.fn(async () => {}),
        });

        await routing.openPathsInAppropriateTab([
            '/docs/first.pdf',
            '/docs/second.pdf',
        ]);

        expect(initialWorkspace.openPath).toHaveBeenCalledWith('/docs/first.pdf');
        expect(createdWorkspaces.get('tab-2')?.openPath).toHaveBeenCalledWith('/docs/second.pdf');
    });

    it('reuses a failed empty tab for the next path instead of stalling the drop batch', async () => {
        const activeGroupId = ref('group-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(true);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();

        const routing = useAppShellWorkspaceRouting({
            activeGroupId,
            activeTabId,
            activeWorkspace: computed(() => workspaceRefs.value.get(activeTabId.value ?? '') ?? null),
            workspaceRefs,
            waitForWorkspace: vi.fn(async (tabId: string) => workspaceRefs.value.get(tabId) ?? null),
            createTab: vi.fn(({ activate }: { activate?: boolean } = {}) => {
                createdCount += 1;
                const tabId = `tab-${createdCount}`;
                const record = createWorkspace(false);
                if (tabId === 'tab-2') {
                    record.openPath.mockRejectedValueOnce(new Error('boom'));
                }
                createdWorkspaces.set(tabId, record);
                workspaceRefs.value.set(tabId, record.workspace);
                if (activate !== false) {
                    activeTabId.value = tabId;
                }
                return createTabStub(tabId);
            }),
            removeTabFromState: vi.fn(),
            resolveTabForAction: vi.fn(() => null),
            handleCloseTab: vi.fn(async () => {}),
            moveTabToNewWindow: vi.fn(async () => {}),
            moveTabToWindow: vi.fn(async () => {}),
            mergeWindowInto: vi.fn(async () => {}),
        });

        await routing.openPathsInAppropriateTab([
            '/docs/first.pdf',
            '/docs/second.pdf',
        ]);

        expect(createdWorkspaces.get('tab-2')?.openPath).toHaveBeenCalledWith('/docs/first.pdf');
        expect(createdWorkspaces.get('tab-2')?.openPath).toHaveBeenNthCalledWith(2, '/docs/second.pdf');
        expect(createdWorkspaces.has('tab-3')).toBe(false);
    });
});
