import {
    computed,
    nextTick,
    ref,
} from 'vue';
import type { Ref } from 'vue';
import {
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

    it('seeds a reused placeholder tab with a document hint before opening the path', async () => {
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
        expect(routingOptions.updateTab.mock.invocationCallOrder[0]).toBeLessThan(
            initialWorkspace.openPath.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
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
                    toolbarSnapshot: createDefaultWorkspaceToolbarSnapshot(),
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

    it('seeds new tabs with document hints so external paths can mount a workspace before opening', async () => {
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

                if (initial?.fileName || initial?.originalPath || initial?.isDjvu) {
                    const record = createWorkspace(false);
                    createdWorkspaces.set(tabId, record);
                    workspaceRefs.value.set(tabId, record.workspace);
                }

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

        expect(routingOptions.createTab).toHaveBeenCalledWith(
            expect.objectContaining({ initial: expect.objectContaining({
                fileName: 'launch-opened.pdf',
                originalPath: '/docs/launch-opened.pdf',
                isDjvu: false,
            }) }),
        );
        expect(createdWorkspaces.get('tab-2')?.openPath).toHaveBeenCalledWith('/docs/launch-opened.pdf');
    });

    it('marks DjVu open results as document hints before opening them in a new tab', async () => {
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

                if (initial?.fileName || initial?.originalPath || initial?.isDjvu) {
                    const record = createWorkspace(false);
                    createdWorkspaces.set(tabId, record);
                    workspaceRefs.value.set(tabId, record.workspace);
                }

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

        await routing.openResultInAppropriateTab(result);

        expect(routingOptions.createTab).toHaveBeenCalledWith(
            expect.objectContaining({ initial: expect.objectContaining({
                fileName: 'reference.djvu',
                originalPath: '/docs/reference.djvu',
                isDjvu: true,
            }) }),
        );
        expect(createdWorkspaces.get('tab-2')?.openResult).toHaveBeenCalledWith(result);
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
                    toolbarSnapshot: createDefaultWorkspaceToolbarSnapshot(),
                })
                : null
        ));
        const routing = useAppShellWorkspaceRouting(routingOptions);

        await expect(routing.openPathInAppropriateTab('/docs/opened.pdf')).resolves.toBe(true);

        expect(routingOptions.removeTabFromState).not.toHaveBeenCalled();
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
                    toolbarSnapshot: createDefaultWorkspaceToolbarSnapshot(),
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
});
