// @vitest-environment happy-dom
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    ref,
    shallowRef,
} from 'vue';
import type {
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentWorkspaceSnapshotRequest,
} from '@contracts/agent';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type { IAgentCapability } from '@contracts/agentCapability';
import type { IPlatformApi } from '@contracts/platformApi';
import { buildAgentWorkspaceSnapshot } from '@app/modules/workspace-shell/agent/buildAgentWorkspaceSnapshot';
import { useAgentWorkspaceSnapshot } from '@app/modules/workspace-shell/composables/useAgentWorkspaceSnapshot';
import { createWorkspaceDocumentSessionCore } from '@app/modules/workspace-shell/document-sessions/createWorkspaceDocumentSessionCore';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IEditorPaneState } from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IRecentFile } from '@contracts/shared';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import type { IWorkspaceDocumentSessionController } from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';
import { cast } from '@tests/helpers/cast';
import { ELECTRON_PLATFORM_MANIFEST } from '@contracts/platformApi';

interface IWindowWithElectronApi extends Window {electronAPI?: IPlatformApi;}

const initialElectronApi = (window as IWindowWithElectronApi).electronAPI;
type TWorkspaceDocumentRecordMap = Record<string, ReturnType<typeof createWorkspaceDocumentRecord>>;

function createWorkspace(
    overrides: Partial<ReturnType<IWorkspaceExpose['getToolbarSnapshot']>>,
    workspaceOverrides: Partial<IWorkspaceExpose> = {},
) {
    return cast<IWorkspaceExpose>({
        getToolbarSnapshot: () => ({
            ...createDefaultWorkspaceToolbarSnapshot(),
            ...overrides,
        }),
        handleGoToPage: vi.fn(),
        readAgentResource: vi.fn(async () => ({ok: true})),
        runAgentAction: vi.fn(async () => ({ok: true})),
        ...workspaceOverrides,
    });
}

function createDocumentIdentity(
    token = 'revision-1',
    contentRevision = 1,
    documentRef = '/tmp/document.pdf',
): IDocumentRevisionInfo {
    return {
        version: 1,
        token,
        documentRef,
        authority: 'browser-document-store',
        contentRevision,
        mintedAt: contentRevision,
    };
}

function createSessionRecord(path = '/tmp/document.pdf') {
    return createWorkspaceDocumentRecord({
        tab: {
            fileName: path.split('/').pop() ?? null,
            originalPath: path,
            isDirty: false,
            isDjvu: false,
        },
        documentIdentity: createDocumentIdentity('revision-1', 1, path),
        toolbarSnapshot: {
            hasPdf: true,
            currentPage: 1,
            totalPages: 3,
        },
    });
}

function createTestSession(path = '/tmp/document.pdf') {
    return createWorkspaceDocumentSessionCore({
        tabId: 'tab-1',
        sessionId: 'session-1',
        initialRecord: createSessionRecord(path),
    });
}

function createElectronApiFixture(agent: IAgentCapability) {
    return cast<IPlatformApi>({
        manifest: ELECTRON_PLATFORM_MANIFEST,
        documents: {
            openDocumentDialog: vi.fn(),
            openDocumentDirect: vi.fn(),
            readFile: vi.fn(),
            registerFilesForOpen: vi.fn(async () => []),
            saveFileStructured: vi.fn(),
            recentFiles: {get: vi.fn()},
        },
        pageOps: {delete: vi.fn()},
        imageExport: {exportPdfToImages: vi.fn()},
        ocr: {recognize: vi.fn()},
        search: {run: vi.fn()},
        djvu: {openForViewing: vi.fn()},
        settings: {get: vi.fn()},
        system: {getMemoryInfo: vi.fn()},
        updates: {getState: vi.fn()},
        windowTabs: {transfer: vi.fn()},
        shell: {openExternal: vi.fn()},
        host: {getEnvironment: vi.fn()},
        agent,
    });
}

async function flushAsyncWork() {
    for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
    }
}

async function waitForCommandResponse(responses: IAgentCommandResponse[]) {
    for (let index = 0; index < 20; index += 1) {
        if (responses[0]) {
            return responses[0];
        }
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error('Timed out waiting for agent command response.');
}

async function mountAgentWorkspaceSnapshotHarness(options: {
    activateTab?: () => void;
    session?: IWorkspaceDocumentSessionController;
    waitForWorkspace?: () => Promise<IWorkspaceExpose | null>;
    workspace?: IWorkspaceExpose;
} = {}) {
    const panes = ref<IEditorPaneState[]>([{
        paneId: 'pane-1',
        tabIds: ['tab-1'],
        activeTabId: 'tab-1',
    }]);
    const tabs = ref<ITab[]>([{
        id: 'tab-1',
        fileName: 'Document.pdf',
        originalPath: '/tmp/document.pdf',
        isDirty: false,
        isDjvu: false,
    }]);
    const activePaneId = ref('pane-1');
    const activeTabId = ref('tab-1');
    const workspace = options.workspace ?? createWorkspace({
        hasPdf: true,
        currentPage: 1,
        totalPages: 3,
    });
    const firstIdentity = createDocumentIdentity('revision-1', 1);
    const initialRecord = createWorkspaceDocumentRecord({
        tab: tabs.value[0],
        documentIdentity: firstIdentity,
        toolbarSnapshot: {
            hasPdf: true,
            currentPage: 1,
            totalPages: 3,
        },
    });
    const documentRecordsByTabId = ref<TWorkspaceDocumentRecordMap>({'tab-1': initialRecord});
    const commandCallbacks: Array<(request: IAgentCommandRequest) => void> = [];
    const snapshotCallbacks: Array<(request: IAgentWorkspaceSnapshotRequest) => void> = [];
    const commandResponses: IAgentCommandResponse[] = [];
    const agent = cast<IAgentCapability>({
        onWorkspaceSnapshotRequest: vi.fn((callback) => {
            snapshotCallbacks.push(callback);
            return vi.fn();
        }),
        submitWorkspaceSnapshot: vi.fn(async () => ({accepted: true})),
        onCommandRequest: vi.fn((callback) => {
            commandCallbacks.push(callback);
            return vi.fn();
        }),
        submitCommandResponse: vi.fn(async (response) => {
            commandResponses.push(response);
            return {accepted: true};
        }),
    });
    (window as IWindowWithElectronApi).electronAPI = createElectronApiFixture(agent);

    const app = createApp({ setup() {
        useAgentWorkspaceSnapshot({
            panes,
            tabs,
            layout: ref(null),
            activePaneId,
            activeTabId,
            workspaceRefs: ref(new Map([[
                'tab-1',
                workspace,
            ]])),
            documentRecordsByTabId,
            ...(options.session === undefined
                ? {}
                : {documentSessionsByTabId: shallowRef({'tab-1': options.session} satisfies Record<string, IWorkspaceDocumentSessionController>)}),
            shouldWaitForDesktopBridge: () => false,
            getPaneByTabId: tabId => panes.value.find(pane => pane.tabIds.includes(tabId)) ?? null,
            activateTab: (paneId, tabId) => {
                activePaneId.value = paneId;
                activeTabId.value = tabId;
                options.activateTab?.();
            },
            waitForWorkspace: options.waitForWorkspace ?? (async () => workspace),
        });
        return () => null;
    } });
    const host = document.createElement('div');
    document.body.append(host);
    app.mount(host);
    await flushAsyncWork();

    return {
        app,
        commandResponses,
        documentRecordsByTabId,
        firstIdentity,
        async submitCommand(request: IAgentCommandRequest) {
            commandCallbacks[0]?.(request);
            return waitForCommandResponse(commandResponses);
        },
        workspace,
    };
}

afterEach(() => {
    const windowWithElectronApi = window as IWindowWithElectronApi;
    if (initialElectronApi === undefined) {
        delete windowWithElectronApi.electronAPI;
    } else {
        windowWithElectronApi.electronAPI = initialElectronApi;
    }
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('buildAgentWorkspaceSnapshot', () => {
    it('serializes panes, tabs, layout, and document preparation recommendations', () => {
        const panes = ref<IEditorPaneState[]>([
            {
                paneId: 'pane-left',
                tabIds: [
                    'tab-pdf',
                    'tab-djvu',
                ],
                activeTabId: 'tab-pdf',
            },
            {
                paneId: 'pane-right',
                tabIds: ['tab-image'],
                activeTabId: 'tab-image',
            },
        ]);
        const tabs = ref<ITab[]>([
            {
                id: 'tab-pdf',
                fileName: 'Grammar.pdf',
                originalPath: '/tmp/Grammar.pdf',
                isDirty: false,
                isDjvu: false,
            },
            {
                id: 'tab-djvu',
                fileName: 'Reader.djvu',
                originalPath: '/tmp/Reader.djvu',
                isDirty: false,
                isDjvu: true,
            },
            {
                id: 'tab-image',
                fileName: 'scan.png',
                originalPath: '/tmp/scan.png',
                isDirty: false,
                isDjvu: false,
            },
        ]);
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>([
            [
                'tab-pdf',
                createWorkspace({
                    hasPdf: true,
                    currentPage: 12,
                    totalPages: 80,
                }),
            ],
            [
                'tab-djvu',
                createWorkspace({
                    isDjvuMode: true,
                    currentPage: 3,
                    totalPages: 9,
                }),
            ],
        ]));
        const layout = ref({
            type: 'split',
            id: 'split-root',
            orientation: 'horizontal',
            ratio: 0.5,
            first: {
                type: 'leaf',
                paneId: 'pane-left',
            },
            second: {
                type: 'leaf',
                paneId: 'pane-right',
            },
        } as const);
        const recentFiles = ref<IRecentFile[]>([{
            fileName: 'Previous.pdf',
            originalPath: '/tmp/Previous.pdf',
            timestamp: Date.UTC(2026, 4, 31),
        }]);
        const documentRecordsByTabId = ref<Record<string, ReturnType<typeof createWorkspaceDocumentRecord>>>({
            'tab-pdf': createWorkspaceDocumentRecord({toolbarSnapshot: {
                hasPdf: true,
                currentPage: 12,
                totalPages: 80,
            }}),
            'tab-djvu': createWorkspaceDocumentRecord({
                tab: {
                    fileName: 'Reader.djvu',
                    originalPath: '/tmp/Reader.djvu',
                    isDirty: false,
                    isDjvu: true,
                },
                toolbarSnapshot: {
                    isDjvuMode: true,
                    currentPage: 3,
                    totalPages: 9,
                },
            }),
        });

        const snapshot = buildAgentWorkspaceSnapshot({
            panes,
            tabs,
            layout,
            activePaneId: ref('pane-left'),
            activeTabId: ref('tab-pdf'),
            recentFiles,
            recentFilesResolved: ref(true),
            workspaceRefs,
            documentRecordsByTabId,
            getPaneByTabId: tabId => panes.value.find(pane => pane.tabIds.includes(tabId)) ?? null,
        });

        expect(snapshot.activePaneId).toBe('pane-left');
        expect(snapshot.summary).toMatchObject({
            mode: 'open-document',
            documentCount: 3,
            recentFileCount: 1,
            recentFilesResolved: true,
            activeDocument: {
                tabId: 'tab-pdf',
                kind: 'pdf',
                originalPath: '/tmp/Grammar.pdf',
            },
        });
        expect(snapshot.recentFiles).toEqual([{
            fileName: 'Previous.pdf',
            originalPath: '/tmp/Previous.pdf',
            kind: 'pdf',
            openedAt: '2026-05-31T00:00:00.000Z',
        }]);
        expect(snapshot.panes).toEqual([
            {
                paneId: 'pane-left',
                tabIds: [
                    'tab-pdf',
                    'tab-djvu',
                ],
                activeTabId: 'tab-pdf',
            },
            {
                paneId: 'pane-right',
                tabIds: ['tab-image'],
                activeTabId: 'tab-image',
            },
        ]);

        const pdfTab = snapshot.tabs.find(tab => tab.tabId === 'tab-pdf');
        expect(pdfTab?.kind).toBe('pdf');
        expect(pdfTab?.currentPage).toBe(12);
        expect(pdfTab?.readiness.ocr?.status).toBe('unknown');
        expect(pdfTab?.readiness.recommendations.map(item => item.id)).toEqual(['ocr_all_pages']);

        const djvuTab = snapshot.tabs.find(tab => tab.tabId === 'tab-djvu');
        expect(djvuTab?.kind).toBe('djvu');
        expect(djvuTab?.readiness.recommendations.map(item => item.id)).toEqual(['convert_to_pdf']);

        const imageTab = snapshot.tabs.find(tab => tab.tabId === 'tab-image');
        expect(imageTab?.kind).toBe('image');
        expect(imageTab?.workspaceAttached).toBe(false);
        expect(imageTab?.readiness.recommendations.map(item => item.id)).toEqual(['convert_to_pdf']);
    });

    it('distinguishes an empty attached tab from an open document and exposes recent files as metadata', () => {
        const panes = ref<IEditorPaneState[]>([{
            paneId: 'pane-start',
            tabIds: ['tab-empty'],
            activeTabId: 'tab-empty',
        }]);
        const tabs = ref<ITab[]>([{
            id: 'tab-empty',
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        }]);
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>([[
            'tab-empty',
            createWorkspace({}),
        ]]));
        const recentFiles = ref<IRecentFile[]>([{
            fileName: 'Recent.djvu',
            originalPath: '/tmp/Recent.djvu',
            timestamp: Date.UTC(2026, 5, 1),
            fileSize: 1234,
        }]);
        const documentRecordsByTabId = ref<Record<string, ReturnType<typeof createWorkspaceDocumentRecord>>>({'tab-empty': createWorkspaceDocumentRecord()});

        const snapshot = buildAgentWorkspaceSnapshot({
            panes,
            tabs,
            layout: ref(null),
            activePaneId: ref('pane-start'),
            activeTabId: ref('tab-empty'),
            recentFiles,
            recentFilesResolved: ref(true),
            workspaceRefs,
            documentRecordsByTabId,
            getPaneByTabId: tabId => panes.value.find(pane => pane.tabIds.includes(tabId)) ?? null,
        });

        expect(snapshot.summary).toEqual({
            mode: 'empty-workspace',
            activeDocument: null,
            documentCount: 0,
            recentFileCount: 1,
            recentFilesResolved: true,
        });
        expect(snapshot.tabs).toEqual([expect.objectContaining({
            tabId: 'tab-empty',
            kind: 'empty',
            workspaceAttached: true,
            readiness: expect.objectContaining({ status: 'empty' }),
        })]);
        expect(snapshot.recentFiles).toEqual([{
            fileName: 'Recent.djvu',
            originalPath: '/tmp/Recent.djvu',
            kind: 'djvu',
            openedAt: '2026-06-01T00:00:00.000Z',
            fileSize: 1234,
        }]);
    });
});

describe('useAgentWorkspaceSnapshot command guards', () => {
    it('passes session command targets into workspace agent contexts', async () => {
        const readAgentResource = vi.fn(async (_uri, context) => ({
            ok: true,
            commandTargetSessionId: context?.commandTarget?.sessionId,
        }));
        const workspace = createWorkspace({
            hasPdf: true,
            currentPage: 1,
            totalPages: 3,
        }, {readAgentResource});
        const session = createTestSession();
        session.attachWorkspace(workspace);
        const harness = await mountAgentWorkspaceSnapshotHarness({
            session,
            workspace,
        });

        const response = await harness.submitCommand({
            requestId: 'command-session-context',
            command: {
                name: 'read_resource',
                arguments: {
                    tabId: 'tab-1',
                    uri: 'evb://document/tab-1/state',
                },
            },
        });

        expect(response).toMatchObject({
            ok: true,
            result: {commandTargetSessionId: 'session-1'},
        });
        expect(readAgentResource).toHaveBeenCalledWith(
            'evb://document/tab-1/state',
            expect.objectContaining({commandTarget: expect.objectContaining({
                kind: 'revision',
                tabId: 'tab-1',
                sessionId: 'session-1',
            })}),
        );
        harness.app.unmount();
    });

    it('rejects a command when the session target changes after activation', async () => {
        const session = createTestSession();
        const harness = await mountAgentWorkspaceSnapshotHarness({
            session,
            activateTab: () => {
                session.applyWorkspaceRecord(createSessionRecord('/tmp/replacement.pdf'), 'workspace');
            },
        });

        const response = await harness.submitCommand({
            requestId: 'command-session-activation-change',
            command: {
                name: 'go_to_page',
                arguments: {
                    tabId: 'tab-1',
                    page: 2,
                },
            },
        });

        expect(response).toMatchObject({
            ok: false,
            error: 'stale-command-target',
        });
        expect(harness.workspace.handleGoToPage).not.toHaveBeenCalled();
        harness.app.unmount();
    });

    it('rejects a command when the target document identity changes after activation', async () => {
        const harnessRef: {current?: Awaited<ReturnType<typeof mountAgentWorkspaceSnapshotHarness>>;} = {};
        const harness = await mountAgentWorkspaceSnapshotHarness({ activateTab: () => {
            const currentHarness = harnessRef.current;
            if (!currentHarness) {
                throw new Error('Expected mounted harness before activation.');
            }
            currentHarness.documentRecordsByTabId.value['tab-1'] = createWorkspaceDocumentRecord({
                tab: {
                    fileName: 'Document.pdf',
                    originalPath: '/tmp/document.pdf',
                    isDirty: false,
                    isDjvu: false,
                },
                documentIdentity: createDocumentIdentity('revision-2', 2),
                toolbarSnapshot: {
                    hasPdf: true,
                    currentPage: 1,
                    totalPages: 3,
                },
            });
        } });
        harnessRef.current = harness;

        const response = await harness.submitCommand({
            requestId: 'command-activate-change',
            command: {
                name: 'go_to_page',
                arguments: {
                    tabId: 'tab-1',
                    page: 2,
                },
            },
        });

        expect(response).toMatchObject({
            ok: false,
            error: 'Agent command target document changed.',
        });
        expect(harness.workspace.handleGoToPage).not.toHaveBeenCalled();
        harness.app.unmount();
    });

    it('rejects a command when the target document identity changes after waiting for workspace', async () => {
        const harnessRef: {current?: Awaited<ReturnType<typeof mountAgentWorkspaceSnapshotHarness>>;} = {};
        const readAgentResource = vi.fn(async () => ({ok: true}));
        const harness = await mountAgentWorkspaceSnapshotHarness({
            workspace: createWorkspace({
                hasPdf: true,
                currentPage: 1,
                totalPages: 3,
            }, {readAgentResource}),
            waitForWorkspace: async () => {
                const currentHarness = harnessRef.current;
                if (!currentHarness) {
                    throw new Error('Expected mounted harness before workspace wait.');
                }
                currentHarness.documentRecordsByTabId.value['tab-1'] = createWorkspaceDocumentRecord({
                    tab: {
                        fileName: 'Document.pdf',
                        originalPath: '/tmp/document.pdf',
                        isDirty: false,
                        isDjvu: false,
                    },
                    documentIdentity: createDocumentIdentity('revision-2', 2),
                    toolbarSnapshot: {
                        hasPdf: true,
                        currentPage: 1,
                        totalPages: 3,
                    },
                });
                return currentHarness.workspace;
            },
        });
        harnessRef.current = harness;

        const response = await harness.submitCommand({
            requestId: 'command-wait-change',
            command: {
                name: 'read_resource',
                arguments: {
                    tabId: 'tab-1',
                    uri: 'evb://document/tab-1/state',
                },
            },
        });

        expect(response).toMatchObject({
            ok: false,
            error: 'Agent command target document changed.',
        });
        expect(readAgentResource).not.toHaveBeenCalled();
        harness.app.unmount();
    });
});
