import {
    computed,
    nextTick,
    ref,
} from 'vue';
import type { Ref } from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createDefaultWorkspaceToolbarSnapshot,
    createDefaultWorkspaceViewerCapabilities,
    type IWorkspaceExpose,
} from '@app/types/workspaceExpose';
import type { ITab } from '@app/types/tabs';
import { useAppShellWorkspaceRouting } from '@app/modules/workspace-shell/composables/useAppShellWorkspaceRouting';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { cast } from '@tests/helpers/cast';

const routingMocks = vi.hoisted(() => ({
    readRecentOpenExactGeometry: vi.fn(),
    openDocumentDirect: vi.fn(),
}));

vi.mock('@app/modules/workspace-shell/host/recentOpenGeometryReadiness', () => ({readRecentOpenExactGeometry: routingMocks.readRecentOpenExactGeometry}));
vi.mock('@app/utils/platformDocuments', () => ({getDocumentOpenCapability: () => ({openDocumentDirect: routingMocks.openDocumentDirect})}));

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
        return true;
    });
    const openResult = vi.fn(async (_result: unknown) => {
        state.value = true;
        return true;
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
                viewerCapabilities: {
                    ...createDefaultWorkspaceViewerCapabilities(),
                    closeableDocument: hasPdf || isDjvuMode,
                    conversionBanner: isDjvuMode,
                    conversionDialog: isDjvuMode,
                    pdfDocument: hasPdf,
                },
            }),
        }),
    };
}

function createRoutingOptions(options: {
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    createTab: (args?: {
        activate?: boolean;
        initial?: Partial<ITab>;
    }) => ITab;
}) {
    return {
        activePaneId: options.activePaneId,
        activeTabId: options.activeTabId,
        activeWorkspace: computed(() => options.workspaceRefs.value.get(options.activeTabId.value ?? '') ?? null),
        workspaceRefs: options.workspaceRefs,
        waitForWorkspace: vi.fn(async (tabId: string) => options.workspaceRefs.value.get(tabId) ?? null),
        getDocumentRecord: vi.fn((_tabId: string | null | undefined): IWorkspaceDocumentRecord | null => null),
        createTab: vi.fn(({
            activate,
            initial,
        }: {
            activate?: boolean;
            initial?: Partial<ITab>;
        } = {}) => options.createTab({
            ...(activate === undefined ? {} : { activate }),
            ...(initial === undefined ? {} : { initial }),
        })),
        getTabById: vi.fn((tabId: string | null | undefined) => (
            tabId
                ? createTabStub(tabId)
                : null
        )),
        updateTab: vi.fn(),
        removeTabFromState: vi.fn(),
        resolveTabForAction: vi.fn(() => null),
        handleCloseTab: vi.fn(async () => {}),
        moveTabToNewWindow: vi.fn(async () => {}),
        moveTabToWindow: vi.fn(async () => {}),
        mergeWindowInto: vi.fn(async () => {}),
    };
}

describe('useAppShellWorkspaceRouting', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        routingMocks.readRecentOpenExactGeometry.mockReturnValue({
            documentId: '/docs/prepared.pdf',
            pageNumber: 1,
            pageCount: 1,
            width: 612,
            height: 792,
            rotation: 0,
            size: 1,
            modifiedAt: 1,
        });
        routingMocks.openDocumentDirect.mockResolvedValue(null);
    });

    it('resolves a cold direct path in main before the host claims its opening transaction', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(false);
        const activeTab = createTabStub('tab-1');
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);
        const result = {
            kind: 'pdf' as const,
            workingPath: '/managed/cold.pdf',
            originalPath: '/docs/cold.pdf',
            openingGeometry: {
                pageNumber: 1 as const,
                pageCount: 431,
                width: 612,
                height: 792,
                rotation: 0 as const,
                size: 538_000_000,
                modifiedAt: 1_720_000_000_000,
            },
        };
        routingMocks.readRecentOpenExactGeometry.mockReturnValueOnce(null);
        routingMocks.openDocumentDirect.mockResolvedValueOnce(result);
        const routingOptions = createRoutingOptions({
            activePaneId,
            activeTabId,
            workspaceRefs,
            createTab: () => {
                throw new Error('should reuse placeholder tab');
            },
        });
        routingOptions.getTabById = vi.fn(() => activeTab);
        const routing = useAppShellWorkspaceRouting(routingOptions);

        await expect(routing.openPathInAppropriateTab('/docs/cold.pdf')).resolves.toBe(true);

        expect(routingMocks.openDocumentDirect).toHaveBeenCalledWith('/docs/cold.pdf');
        expect(initialWorkspace.openPath).not.toHaveBeenCalled();
        expect(initialWorkspace.openResult).toHaveBeenCalledWith(result);
    });

    it('keeps a revision-validated Recent path on the immediate host-claim route', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(false);
        const activeTab = createTabStub('tab-1');
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);
        const routingOptions = createRoutingOptions({
            activePaneId,
            activeTabId,
            workspaceRefs,
            createTab: () => {
                throw new Error('should reuse placeholder tab');
            },
        });
        routingOptions.getTabById = vi.fn(() => activeTab);
        const routing = useAppShellWorkspaceRouting(routingOptions);

        await expect(routing.openPathInAppropriateTab('/docs/prepared.pdf')).resolves.toBe(true);

        expect(routingMocks.openDocumentDirect).not.toHaveBeenCalled();
        expect(initialWorkspace.openPath).toHaveBeenCalledWith('/docs/prepared.pdf');
        expect(initialWorkspace.openResult).not.toHaveBeenCalled();
    });

    it('opens each external path in its own tab instead of batching them into one workspace', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(true);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();

        const routing = useAppShellWorkspaceRouting(createRoutingOptions({
            activePaneId,
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
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(false);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();

        const routing = useAppShellWorkspaceRouting(createRoutingOptions({
            activePaneId,
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

    it('claims a reused placeholder open before publishing its document hint', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(false);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);
        const activeTab = createTabStub('tab-1');

        const routingOptions = createRoutingOptions({
            activePaneId,
            activeTabId,
            workspaceRefs,
            createTab: () => {
                throw new Error('should reuse placeholder tab');
            },
        });
        routingOptions.getTabById = vi.fn((tabId: string | null | undefined) => (
            tabId === 'tab-1' ? activeTab : null
        ));
        routingOptions.updateTab = vi.fn((tabId: string, updates: Partial<ITab>) => {
            if (tabId === 'tab-1') {
                Object.assign(activeTab, updates);
            }
        });

        const routing = useAppShellWorkspaceRouting(routingOptions);

        await routing.openPathInAppropriateTab('/docs/cold-start.pdf');

        expect(routingOptions.updateTab).toHaveBeenCalledWith('tab-1', expect.objectContaining({
            fileName: 'cold-start.pdf',
            originalPath: '/docs/cold-start.pdf',
            isDjvu: false,
        }));
        expect(initialWorkspace.openPath.mock.invocationCallOrder[0]).toBeLessThan(
            routingOptions.updateTab.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
        );
        expect(initialWorkspace.openPath).toHaveBeenCalledWith('/docs/cold-start.pdf');
    });

    it('does not let a pending document hint make the first placeholder open look occupied', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(false);
        const activeTab = createTabStub('tab-1');
        initialWorkspace.workspace.getToolbarSnapshot = () => ({
            ...createDefaultWorkspaceToolbarSnapshot(),
            isOpeningDocument: Boolean(activeTab.fileName),
        });
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        const routingOptions = createRoutingOptions({
            activePaneId,
            activeTabId,
            workspaceRefs,
            createTab: () => {
                throw new Error('should not create a new tab after reserving the active placeholder');
            },
        });
        routingOptions.getTabById = vi.fn((tabId: string | null | undefined) => (
            tabId === 'tab-1' ? activeTab : null
        ));
        routingOptions.updateTab = vi.fn((tabId: string, updates: Partial<ITab>) => {
            if (tabId === 'tab-1') {
                Object.assign(activeTab, updates);
            }
        });

        const routing = useAppShellWorkspaceRouting(routingOptions);

        await routing.openPathInAppropriateTab('/docs/cold-start.pdf');

        expect(routingOptions.createTab).not.toHaveBeenCalled();
        expect(routingOptions.updateTab).toHaveBeenCalledWith('tab-1', expect.objectContaining({
            fileName: 'cold-start.pdf',
            originalPath: '/docs/cold-start.pdf',
        }));
        expect(initialWorkspace.openPath).toHaveBeenCalledWith('/docs/cold-start.pdf');
    });

    it('opens in a new tab when a reusable placeholder reports a failed direct open', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(false);
        initialWorkspace.openPath.mockResolvedValueOnce(false);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();

        const routing = useAppShellWorkspaceRouting(createRoutingOptions({
            activePaneId,
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

        await routing.openPathInAppropriateTab('/docs/retry-in-new-tab.pdf');

        expect(initialWorkspace.openPath).toHaveBeenCalledTimes(1);
        expect(initialWorkspace.openPath).toHaveBeenCalledWith('/docs/retry-in-new-tab.pdf');
        expect(createdWorkspaces.get('tab-2')?.openPath).toHaveBeenCalledWith('/docs/retry-in-new-tab.pdf');
    });

    it('reuses the active placeholder tab during startup even before its workspace ref is registered', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(false);

        const routingOptions = createRoutingOptions({
            activePaneId,
            activeTabId,
            workspaceRefs,
            createTab: () => {
                throw new Error('should not create a new tab for startup reuse');
            },
        });
        routingOptions.waitForWorkspace = vi.fn(async (tabId: string) => {
            if (tabId !== 'tab-1') {
                return null;
            }

            workspaceRefs.value.set('tab-1', initialWorkspace.workspace);
            return initialWorkspace.workspace;
        });
        const routing = useAppShellWorkspaceRouting(routingOptions);

        await routing.openPathsInAppropriateTab(['/docs/cold-start.pdf']);

        expect(routingOptions.createTab).not.toHaveBeenCalled();
        expect(initialWorkspace.openPath).toHaveBeenCalledWith('/docs/cold-start.pdf');
    });

    it('treats a DjVu tab as occupied and opens dropped PDFs in a new tab', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(false, true);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();

        const routing = useAppShellWorkspaceRouting(createRoutingOptions({
            activePaneId,
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
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(false, false, true);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();

        const routing = useAppShellWorkspaceRouting(createRoutingOptions({
            activePaneId,
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

    it('treats document record metadata as occupied when toolbar capabilities lag behind', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(false, false);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();
        const routingOptions = createRoutingOptions({
            activePaneId,
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
        });
        routingOptions.getDocumentRecord = vi.fn((tabId: string | null | undefined) => (
            tabId === 'tab-1'
                ? cast({
                    tab: {
                        fileName: 'source.djvu',
                        originalPath: '/docs/source.djvu',
                        isDirty: false,
                        isDjvu: true,
                    },
                    documentIdentity: null,
                    toolbarSnapshot: {
                        ...createDefaultWorkspaceToolbarSnapshot(),
                        initialVisualReady: true,
                    },
                })
                : null
        ));

        const routing = useAppShellWorkspaceRouting(routingOptions);

        await routing.openPathInAppropriateTab('/docs/replacement.pdf');

        expect(initialWorkspace.openPath).not.toHaveBeenCalled();
        expect(createdWorkspaces.get('tab-2')?.openPath).toHaveBeenCalledWith('/docs/replacement.pdf');
    });

    it('reuses a failed empty tab for the next path instead of stalling the drop batch', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(true);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();

        const routing = useAppShellWorkspaceRouting(createRoutingOptions({
            activePaneId,
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
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(false);
        initialWorkspace.openPath.mockImplementation(async (_path: string) => true);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();

        const routing = useAppShellWorkspaceRouting(createRoutingOptions({
            activePaneId,
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

    it('claims a new-tab open before publishing its document hint', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(true);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();

        const routingOptions = createRoutingOptions({
            activePaneId,
            activeTabId,
            workspaceRefs,
            createTab: ({
                activate,
                initial,
            }: {
                activate?: boolean;
                initial?: Partial<ITab>;
            } = {}) => {
                createdCount += 1;
                const tabId = `tab-${createdCount}`;

                const record = createWorkspace(false);
                createdWorkspaces.set(tabId, record);
                workspaceRefs.value.set(tabId, record.workspace);

                if (activate !== false) {
                    activeTabId.value = tabId;
                }

                return {
                    ...createTabStub(tabId),
                    ...initial,
                };
            },
        });
        const routing = useAppShellWorkspaceRouting(routingOptions);

        await routing.openPathInAppropriateTab('/docs/launch-opened.pdf');

        expect(routingOptions.createTab).toHaveBeenCalledWith(expect.not.objectContaining({initial: expect.anything()}));
        expect(routingOptions.updateTab).toHaveBeenCalledWith('tab-2', expect.objectContaining({
            fileName: 'launch-opened.pdf',
            originalPath: '/docs/launch-opened.pdf',
            isDjvu: false,
        }));
        expect(createdWorkspaces.get('tab-2')?.openPath.mock.invocationCallOrder[0]).toBeLessThan(
            routingOptions.updateTab.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
        );
        expect(createdWorkspaces.get('tab-2')?.openPath).toHaveBeenCalledWith('/docs/launch-opened.pdf');
    });

    it('claims DjVu result opens before publishing their new-tab hints', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(true);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        let createdCount = 1;
        const createdWorkspaces = new Map<string, IWorkspaceRecord>();

        const routingOptions = createRoutingOptions({
            activePaneId,
            activeTabId,
            workspaceRefs,
            createTab: ({
                activate,
                initial,
            }: {
                activate?: boolean;
                initial?: Partial<ITab>;
            } = {}) => {
                createdCount += 1;
                const tabId = `tab-${createdCount}`;

                const record = createWorkspace(false);
                createdWorkspaces.set(tabId, record);
                workspaceRefs.value.set(tabId, record.workspace);

                if (activate !== false) {
                    activeTabId.value = tabId;
                }

                return {
                    ...createTabStub(tabId),
                    ...initial,
                };
            },
        });
        const routing = useAppShellWorkspaceRouting(routingOptions);
        const result = {
            kind: 'djvu' as const,
            workingPath: '' as const,
            originalPath: '/docs/reference.djvu',
        };

        const opened = await routing.openResultInAppropriateTab(result);

        expect(routingOptions.createTab).toHaveBeenCalledWith(expect.not.objectContaining({initial: expect.anything()}));
        expect(routingOptions.updateTab).toHaveBeenCalledWith('tab-2', expect.objectContaining({
            fileName: 'reference.djvu',
            originalPath: '/docs/reference.djvu',
            isDjvu: true,
        }));
        expect(createdWorkspaces.get('tab-2')?.openResult).toHaveBeenCalledWith(result);
        expect(opened).toBe(true);
    });

    it('removes a startup-created tab when its direct open reports failure', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(true);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        const routingOptions = createRoutingOptions({
            activePaneId,
            activeTabId,
            workspaceRefs,
            createTab: () => {
                const tabId = 'tab-2';
                const record = createWorkspace(false);
                record.openPath.mockResolvedValueOnce(false);
                workspaceRefs.value.set(tabId, record.workspace);
                return createTabStub(tabId);
            },
        });
        const routing = useAppShellWorkspaceRouting(routingOptions);

        const failedPaths = await routing.beginOpenPathsInAppropriateTab(['/docs/startup-failed.pdf']);

        expect(routingOptions.removeTabFromState).toHaveBeenCalledWith('tab-2');
        expect(failedPaths).toEqual(['/docs/startup-failed.pdf']);
    });

    it('keeps a new external-open tab when document state settles after a false open return', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(true);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        const routingOptions = createRoutingOptions({
            activePaneId,
            activeTabId,
            workspaceRefs,
            createTab: () => {
                const tabId = 'tab-2';
                const record = createWorkspace(false);
                record.openPath.mockResolvedValueOnce(false);
                workspaceRefs.value.set(tabId, record.workspace);
                return createTabStub(tabId);
            },
        });
        routingOptions.getDocumentRecord.mockImplementation((tabId: string | null | undefined) => (
            tabId === 'tab-2'
                ? cast({
                    tab: {
                        fileName: 'opened.pdf',
                        originalPath: '/docs/opened.pdf',
                        isDirty: false,
                        isDjvu: false,
                    },
                    documentIdentity: null,
                    toolbarSnapshot: {
                        ...createDefaultWorkspaceToolbarSnapshot(),
                        initialVisualReady: true,
                    },
                })
                : null
        ));
        const routing = useAppShellWorkspaceRouting(routingOptions);

        await expect(routing.openPathInAppropriateTab('/docs/opened.pdf')).resolves.toBe(true);

        expect(routingOptions.removeTabFromState).not.toHaveBeenCalled();
    });

    it('does not treat a seeded tab name and path as proof that a failed open succeeded', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        workspaceRefs.value.set('tab-1', createWorkspace(true).workspace);

        const routingOptions = createRoutingOptions({
            activePaneId,
            activeTabId,
            workspaceRefs,
            createTab: () => {
                const record = createWorkspace(false);
                record.openPath.mockResolvedValueOnce(false);
                workspaceRefs.value.set('tab-2', record.workspace);
                return createTabStub('tab-2');
            },
        });
        routingOptions.getDocumentRecord.mockImplementation((tabId: string | null | undefined) => (
            tabId === 'tab-2'
                ? cast({
                    tab: {
                        fileName: 'seeded.pdf',
                        originalPath: '/docs/seeded.pdf',
                        isDirty: false,
                        isDjvu: false,
                    },
                    documentIdentity: null,
                    toolbarSnapshot: createDefaultWorkspaceToolbarSnapshot(),
                })
                : null
        ));

        await expect(useAppShellWorkspaceRouting(routingOptions)
            .openPathInAppropriateTab('/docs/seeded.pdf')).resolves.toBe(false);
        expect(routingOptions.removeTabFromState).toHaveBeenCalledWith('tab-2');
    });

    it('does not publish metadata from the resolved-workspace fallback when open fails', async () => {
        vi.useFakeTimers();
        try {
            const activePaneId = ref('pane-1');
            const activeTabId = ref('tab-1');
            const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
            const activeTab = createTabStub('tab-1');
            const fallbackWorkspace = createWorkspace(false);
            fallbackWorkspace.openPath.mockResolvedValueOnce(false);
            let tabLookupCount = 0;

            const routingOptions = createRoutingOptions({
                activePaneId,
                activeTabId,
                workspaceRefs,
                createTab: () => createTabStub('tab-2'),
            });
            routingOptions.getTabById = vi.fn((tabId: string | null | undefined) => {
                if (tabId !== 'tab-1') {
                    return null;
                }
                tabLookupCount += 1;
                return tabLookupCount === 1 ? null : activeTab;
            });
            routingOptions.waitForWorkspace = vi.fn(async (tabId: string) => (
                tabId === 'tab-1' ? fallbackWorkspace.workspace : null
            ));
            routingOptions.updateTab = vi.fn((tabId: string, updates: Partial<ITab>) => {
                if (tabId === activeTab.id) {
                    Object.assign(activeTab, updates);
                }
            });

            const openPromise = useAppShellWorkspaceRouting(routingOptions)
                .openPathInAppropriateTab('/docs/fallback-failed.pdf');
            await vi.advanceTimersByTimeAsync(1_000);
            await expect(openPromise).resolves.toBe(false);
            expect(routingOptions.updateTab).not.toHaveBeenCalled();
            expect(activeTab).toEqual(expect.objectContaining({
                fileName: null,
                originalPath: null,
                isDjvu: false,
            }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('restores reserved-tab metadata when its open fails', async () => {
        vi.useFakeTimers();
        try {
            const activePaneId = ref('pane-1');
            const activeTabId = ref('tab-1');
            const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
            const reservedTab: ITab = {
                ...createTabStub('tab-reserved'),
                fileName: 'Previous.pdf',
                originalPath: '/docs/previous.pdf',
            };
            const workspace = createWorkspace(false);
            workspace.openPath.mockResolvedValueOnce(false);
            workspaceRefs.value.set(reservedTab.id, workspace.workspace);
            const routingOptions = createRoutingOptions({
                activePaneId,
                activeTabId,
                workspaceRefs,
                createTab: () => createTabStub('unused'),
            });
            routingOptions.getTabById = vi.fn((tabId: string | null | undefined) => (
                tabId === reservedTab.id ? reservedTab : null
            ));
            routingOptions.updateTab = vi.fn((tabId: string, updates: Partial<ITab>) => {
                if (tabId === reservedTab.id) {
                    Object.assign(reservedTab, updates);
                }
            });

            const openPromise = useAppShellWorkspaceRouting(routingOptions)
                .openPathInReservedTab(reservedTab.id, '/docs/restore-failed.pdf');
            await vi.advanceTimersByTimeAsync(1_000);
            await expect(openPromise).resolves.toBe(false);
            expect(reservedTab).toEqual(expect.objectContaining({
                fileName: 'Previous.pdf',
                originalPath: '/docs/previous.pdf',
                isDjvu: false,
            }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps a matching accepted large document while its first visual is still pending', async () => {
        vi.useFakeTimers();
        try {
            const activePaneId = ref('pane-1');
            const activeTabId = ref('tab-1');
            const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
            const activeTab = createTabStub('tab-1');
            const workspace = createWorkspace(false);
            workspace.openPath.mockResolvedValueOnce(false);
            workspaceRefs.value.set(activeTab.id, workspace.workspace);
            let documentAccepted = false;
            const createTab = vi.fn(() => createTabStub('tab-fallback'));
            const routingOptions = createRoutingOptions({
                activePaneId,
                activeTabId,
                workspaceRefs,
                createTab,
            });
            routingOptions.getTabById = vi.fn((tabId: string | null | undefined) => (
                tabId === activeTab.id ? activeTab : null
            ));
            routingOptions.getDocumentRecord.mockImplementation((tabId: string | null | undefined) => (
                tabId === activeTab.id && documentAccepted
                    ? cast({
                        tab: {
                            ...activeTab,
                            fileName: 'large.pdf',
                            originalPath: '/docs/large.pdf',
                        },
                        documentIdentity: null,
                        toolbarSnapshot: {
                            ...createDefaultWorkspaceToolbarSnapshot(),
                            hasPdf: true,
                            initialVisualReady: false,
                            isOpeningDocument: false,
                            totalPages: 431,
                        },
                    })
                    : null
            ));

            const openPromise = useAppShellWorkspaceRouting(routingOptions)
                .openPathInAppropriateTab('/docs/large.pdf');
            await vi.advanceTimersByTimeAsync(100);
            documentAccepted = true;
            await vi.advanceTimersByTimeAsync(100);

            await expect(openPromise).resolves.toBe(true);
            expect(createTab).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not mistake a previously ready document for the requested target', async () => {
        vi.useFakeTimers();
        try {
            const activePaneId = ref('pane-1');
            const activeTabId = ref('tab-1');
            const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
            const reservedTab = createTabStub('tab-reserved');
            const workspace = createWorkspace(false);
            workspace.openPath.mockResolvedValueOnce(false);
            workspaceRefs.value.set(reservedTab.id, workspace.workspace);
            const routingOptions = createRoutingOptions({
                activePaneId,
                activeTabId,
                workspaceRefs,
                createTab: () => createTabStub('unused'),
            });
            routingOptions.getTabById = vi.fn((tabId: string | null | undefined) => (
                tabId === reservedTab.id ? reservedTab : null
            ));
            routingOptions.getDocumentRecord.mockReturnValue(cast({
                tab: {
                    ...reservedTab,
                    fileName: 'old.pdf',
                    originalPath: '/docs/old.pdf',
                },
                documentIdentity: null,
                toolbarSnapshot: {
                    ...createDefaultWorkspaceToolbarSnapshot(),
                    hasPdf: true,
                    initialVisualReady: true,
                },
            }));

            const openPromise = useAppShellWorkspaceRouting(routingOptions)
                .openPathInReservedTab(reservedTab.id, '/docs/new.pdf');
            await vi.advanceTimersByTimeAsync(1_000);

            await expect(openPromise).resolves.toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps reserved-tab identity when a visually settled document arrives after a false open return', async () => {
        vi.useFakeTimers();
        try {
            const activePaneId = ref('pane-1');
            const activeTabId = ref('tab-1');
            const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
            const reservedTab = createTabStub('tab-reserved');
            const workspace = createWorkspace(false);
            workspace.openPath.mockResolvedValueOnce(false);
            workspaceRefs.value.set(reservedTab.id, workspace.workspace);
            let visuallySettled = false;
            const routingOptions = createRoutingOptions({
                activePaneId,
                activeTabId,
                workspaceRefs,
                createTab: () => createTabStub('unused'),
            });
            routingOptions.getTabById = vi.fn((tabId: string | null | undefined) => (
                tabId === reservedTab.id ? reservedTab : null
            ));
            routingOptions.updateTab = vi.fn((tabId: string, updates: Partial<ITab>) => {
                if (tabId === reservedTab.id) Object.assign(reservedTab, updates);
            });
            routingOptions.getDocumentRecord.mockImplementation((tabId: string | null | undefined) => (
                tabId === reservedTab.id && visuallySettled
                    ? cast({
                        tab: {
                            ...reservedTab,
                            fileName: 'restored.pdf',
                            originalPath: '/docs/restored.pdf',
                        },
                        documentIdentity: {originalPath: '/docs/restored.pdf'},
                        toolbarSnapshot: {
                            ...createDefaultWorkspaceToolbarSnapshot(),
                            initialVisualReady: true,
                        },
                    })
                    : null
            ));

            const openPromise = useAppShellWorkspaceRouting(routingOptions)
                .openPathInReservedTab(reservedTab.id, '/docs/restored.pdf');
            await vi.advanceTimersByTimeAsync(100);
            visuallySettled = true;
            await vi.advanceTimersByTimeAsync(100);

            await expect(openPromise).resolves.toBe(true);
            expect(reservedTab).toEqual(expect.objectContaining({
                fileName: 'restored.pdf',
                originalPath: '/docs/restored.pdf',
            }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps a startup-created tab when document state settles after a false open return', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(true);
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        const routingOptions = createRoutingOptions({
            activePaneId,
            activeTabId,
            workspaceRefs,
            createTab: () => {
                const tabId = 'tab-2';
                const record = createWorkspace(false);
                record.openPath.mockResolvedValueOnce(false);
                workspaceRefs.value.set(tabId, record.workspace);
                return createTabStub(tabId);
            },
        });
        routingOptions.getDocumentRecord.mockImplementation((tabId: string | null | undefined) => (
            tabId === 'tab-2'
                ? cast({
                    tab: {
                        fileName: 'startup.pdf',
                        originalPath: '/docs/startup.pdf',
                        isDirty: false,
                        isDjvu: false,
                    },
                    documentIdentity: null,
                    toolbarSnapshot: {
                        ...createDefaultWorkspaceToolbarSnapshot(),
                        initialVisualReady: true,
                    },
                })
                : null
        ));
        const routing = useAppShellWorkspaceRouting(routingOptions);

        await expect(routing.beginOpenPathsInAppropriateTab(['/docs/startup.pdf'])).resolves.toEqual([]);

        expect(routingOptions.removeTabFromState).not.toHaveBeenCalled();
    });

    it('keeps startup path opening pending until the active placeholder open settles', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const initialWorkspace = createWorkspace(false);
        let resolveOpen: (() => void) | undefined;
        initialWorkspace.openPath.mockImplementation(async (_path: string) => new Promise<boolean>((resolve) => {
            resolveOpen = () => resolve(true);
        }));
        workspaceRefs.value.set('tab-1', initialWorkspace.workspace);

        const routing = useAppShellWorkspaceRouting(createRoutingOptions({
            activePaneId,
            activeTabId,
            workspaceRefs,
            createTab: () => {
                throw new Error('should reuse placeholder tab');
            },
        }));

        let beginSettled = false;
        const beginPromise = routing
            .beginOpenPathsInAppropriateTab(['/docs/startup.pdf'])
            .then(() => {
                beginSettled = true;
            });
        await Promise.resolve();
        await nextTick();

        expect(initialWorkspace.openPath).toHaveBeenCalledWith('/docs/startup.pdf');
        expect(beginSettled).toBe(false);

        resolveOpen?.();
        await beginPromise;

        expect(beginSettled).toBe(true);
    });

    it('does not seed a startup active-tab hint when the workspace is unavailable', async () => {
        const activePaneId = ref('pane-1');
        const activeTabId = ref('tab-1');
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
        const activeTab = createTabStub('tab-1');

        const routingOptions = createRoutingOptions({
            activePaneId,
            activeTabId,
            workspaceRefs,
            createTab: () => {
                throw new Error('should not create a fallback tab for a single failed startup claim');
            },
        });
        routingOptions.getTabById = vi.fn((tabId: string | null | undefined) => (
            tabId === 'tab-1' ? activeTab : null
        ));
        const routing = useAppShellWorkspaceRouting(routingOptions);

        await expect(routing.beginOpenPathsInAppropriateTab(['/docs/unavailable.pdf'])).resolves.toEqual(['/docs/unavailable.pdf']);

        expect(routingOptions.updateTab).not.toHaveBeenCalled();
        expect(activeTab.originalPath).toBeNull();
    });

    it('does not publish a startup active-tab hint when the open never settles', async () => {
        vi.useFakeTimers();
        try {
            const activePaneId = ref('pane-1');
            const activeTabId = ref('tab-1');
            const workspaceRefs = ref(new Map<string, IWorkspaceExpose>());
            const initialWorkspace = createWorkspace(false);
            initialWorkspace.openPath.mockResolvedValueOnce(false);
            workspaceRefs.value.set('tab-1', initialWorkspace.workspace);
            const activeTab = createTabStub('tab-1');

            const routingOptions = createRoutingOptions({
                activePaneId,
                activeTabId,
                workspaceRefs,
                createTab: () => {
                    throw new Error('should not create a fallback tab for a single failed startup claim');
                },
            });
            routingOptions.getTabById = vi.fn((tabId: string | null | undefined) => (
                tabId === 'tab-1' ? activeTab : null
            ));
            routingOptions.updateTab = vi.fn((tabId: string, updates: Partial<ITab>) => {
                if (tabId === 'tab-1') {
                    Object.assign(activeTab, updates);
                }
            });
            const routing = useAppShellWorkspaceRouting(routingOptions);

            const openPromise = routing.beginOpenPathsInAppropriateTab(['/docs/failed-startup.pdf']);
            await Promise.resolve();

            expect(activeTab.originalPath).toBeNull();

            await vi.advanceTimersByTimeAsync(1_000);
            await expect(openPromise).resolves.toEqual(['/docs/failed-startup.pdf']);

            expect(activeTab).toEqual(expect.objectContaining({
                fileName: null,
                originalPath: null,
                isDjvu: false,
            }));
        } finally {
            vi.useRealTimers();
        }
    });
});
