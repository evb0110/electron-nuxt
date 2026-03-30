import {
    computed,
    ref,
    type Ref,
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

function createWorkspace(hasPdf = false, isDjvuMode = false, isOpeningDocument = false): IWorkspaceRecord {
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
            getToolbarSnapshot: () => cast<IWorkspaceExpose['getToolbarSnapshot'] extends () => infer T ? T : never>({
                isDjvuMode,
                isOpeningDocument,
            }),
        }),
    };
}

function createRoutingOptions(options: {
    activeGroupId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    createTab: (args?: { activate?: boolean }) => ITab;
}) {
    return {
        activeGroupId: options.activeGroupId,
        activeTabId: options.activeTabId,
        activeWorkspace: computed(() => options.workspaceRefs.value.get(options.activeTabId.value ?? '') ?? null),
        workspaceRefs: options.workspaceRefs,
        waitForWorkspace: vi.fn(async (tabId: string) => options.workspaceRefs.value.get(tabId) ?? null),
        createTab: vi.fn(({ activate }: { activate?: boolean } = {}) => options.createTab({ activate })),
        getTabById: vi.fn((tabId: string | null | undefined) => (
            tabId
                ? createTabStub(tabId)
                : null
        )),
        removeTabFromState: vi.fn(),
        resolveTabForAction: vi.fn(() => null),
        handleCloseTab: vi.fn(async () => {}),
        moveTabToNewWindow: vi.fn(async () => {}),
        moveTabToWindow: vi.fn(async () => {}),
        mergeWindowInto: vi.fn(async () => {}),
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

        const routing = useAppShellWorkspaceRouting(createRoutingOptions({
            activeGroupId,
            activeTabId,
            workspaceRefs,
            createTab: ({ activate }: { activate?: boolean } = {}) => {
                createdCount += 1;
                const tabId = `tab-${createdCount}`;
                const record = createWorkspace(false);
                createdWorkspaces.set(tabId, record);
                workspaceRefs.value.set(tabId, record.workspace);
                if (activate !== false) {
                    activeTabId.value = tabId;
                }
                return createTabStub(tabId);
            },
        }));

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

        const routing = useAppShellWorkspaceRouting(createRoutingOptions({
            activeGroupId,
            activeTabId,
            workspaceRefs,
            createTab: ({ activate }: { activate?: boolean } = {}) => {
                createdCount += 1;
                const tabId = `tab-${createdCount}`;
                const record = createWorkspace(false);
                createdWorkspaces.set(tabId, record);
                workspaceRefs.value.set(tabId, record.workspace);
                if (activate !== false) {
                    activeTabId.value = tabId;
                }
                return createTabStub(tabId);
            },
        }));

        await routing.openPathsInAppropriateTab([
            '/docs/first.pdf',
            '/docs/second.pdf',
        ]);

        expect(initialWorkspace.openPath).toHaveBeenCalledWith('/docs/first.pdf');
        expect(createdWorkspaces.get('tab-2')?.openPath).toHaveBeenCalledWith('/docs/second.pdf');
    });

    it('treats a DjVu tab as occupied and opens dropped PDFs in a new tab', async () => {
        const activeGroupId = ref('group-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(false, true);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();

        const routing = useAppShellWorkspaceRouting(createRoutingOptions({
            activeGroupId,
            activeTabId,
            workspaceRefs,
            createTab: ({ activate }: { activate?: boolean } = {}) => {
                createdCount += 1;
                const tabId = `tab-${createdCount}`;
                const record = createWorkspace(false);
                createdWorkspaces.set(tabId, record);
                workspaceRefs.value.set(tabId, record.workspace);
                if (activate !== false) {
                    activeTabId.value = tabId;
                }
                return createTabStub(tabId);
            },
        }));

        await routing.openPathsInAppropriateTab(['/docs/replacement.pdf']);

        expect(initialWorkspace.openPath).not.toHaveBeenCalled();
        expect(createdWorkspaces.get('tab-2')?.openPath).toHaveBeenCalledWith('/docs/replacement.pdf');
    });

    it('treats an in-flight document open as occupied and opens later external paths in a new tab', async () => {
        const activeGroupId = ref('group-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(false, false, true);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();

        const routing = useAppShellWorkspaceRouting(createRoutingOptions({
            activeGroupId,
            activeTabId,
            workspaceRefs,
            createTab: ({ activate }: { activate?: boolean } = {}) => {
                createdCount += 1;
                const tabId = `tab-${createdCount}`;
                const record = createWorkspace(false);
                createdWorkspaces.set(tabId, record);
                workspaceRefs.value.set(tabId, record.workspace);
                if (activate !== false) {
                    activeTabId.value = tabId;
                }
                return createTabStub(tabId);
            },
        }));

        await routing.openPathsInAppropriateTab(['/docs/replacement.pdf']);

        expect(initialWorkspace.openPath).not.toHaveBeenCalled();
        expect(createdWorkspaces.get('tab-2')?.openPath).toHaveBeenCalledWith('/docs/replacement.pdf');
    });

    it('reuses a failed empty tab for the next path instead of stalling the drop batch', async () => {
        const activeGroupId = ref('group-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(true);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();

        const routing = useAppShellWorkspaceRouting(createRoutingOptions({
            activeGroupId,
            activeTabId,
            workspaceRefs,
            createTab: ({ activate }: { activate?: boolean } = {}) => {
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
            },
        }));

        await routing.openPathsInAppropriateTab([
            '/docs/first.pdf',
            '/docs/second.pdf',
        ]);

        expect(createdWorkspaces.get('tab-2')?.openPath).toHaveBeenCalledWith('/docs/first.pdf');
        expect(createdWorkspaces.get('tab-2')?.openPath).toHaveBeenNthCalledWith(2, '/docs/second.pdf');
        expect(createdWorkspaces.has('tab-3')).toBe(false);
    });

    it('keeps later dropped paths out of the active tab even when its document state lags behind the first open', async () => {
        const activeGroupId = ref('group-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(false);
        initialWorkspace.openPath.mockImplementation(async (_path: string) => {});
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();

        const routing = useAppShellWorkspaceRouting(createRoutingOptions({
            activeGroupId,
            activeTabId,
            workspaceRefs,
            createTab: ({ activate }: { activate?: boolean } = {}) => {
                createdCount += 1;
                const tabId = `tab-${createdCount}`;
                const record = createWorkspace(false);
                createdWorkspaces.set(tabId, record);
                workspaceRefs.value.set(tabId, record.workspace);
                if (activate !== false) {
                    activeTabId.value = tabId;
                }
                return createTabStub(tabId);
            },
        }));

        await routing.openPathsInAppropriateTab([
            '/docs/first.pdf',
            '/docs/second.pdf',
        ]);

        expect(initialWorkspace.openPath).toHaveBeenCalledTimes(1);
        expect(initialWorkspace.openPath).toHaveBeenCalledWith('/docs/first.pdf');
        expect(initialWorkspace.openPath).not.toHaveBeenCalledWith('/docs/second.pdf');
        expect(createdWorkspaces.get('tab-2')?.openPath).toHaveBeenCalledWith('/docs/second.pdf');
    });
});
