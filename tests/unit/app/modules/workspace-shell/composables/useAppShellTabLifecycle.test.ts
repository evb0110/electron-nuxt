import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
    shallowRef,
    watch,
} from 'vue';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type { IEditorPaneState } from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import { useAppShellTabLifecycle } from '@app/modules/workspace-shell/composables/useAppShellTabLifecycle';
import { useShellWorkspaceToolbar } from '@app/modules/workspace-shell/composables/useShellWorkspaceToolbar';
import { useWorkspaceDocumentSessions } from '@app/modules/workspace-shell/document-sessions/useWorkspaceDocumentSessions';
import { useWorkspaceShellState } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import {
    createWorkspaceDocumentRecord,
    type IWorkspaceDocumentRecord,
} from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { cast } from '@tests/helpers/cast';
import {
    createDefaultWorkspaceToolbarSnapshot,
    createDefaultWorkspaceViewerCapabilities,
    type IWorkspaceExpose,
    type IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import {requireDocumentRevisionToken} from '@contracts';

vi.mock('@app/composables/useRuntimeErrorReports', () => ({useRuntimeErrorReports: () => ({reportRuntimeError: vi.fn()})}));

function createDocumentRevision(
    token: string,
    documentRef: string,
    mintedAt: number,
): IDocumentRevisionInfo {
    return {
        version: 1,
        token: requireDocumentRevisionToken(token),
        documentRef,
        authority: 'browser-document-store',
        contentRevision: mintedAt,
        mintedAt,
    };
}

function createReadyRecord(
    fileName: string,
    originalPath: string,
    options: {
        canSave?: boolean;
        documentRef?: string;
        revisionToken?: string;
        toolbarSnapshot?: Partial<IWorkspaceToolbarSnapshot>;
    } = {},
) {
    const documentRef = options.documentRef ?? `${originalPath}.working`;
    const revisionToken = options.revisionToken ?? `revision:${documentRef}`;

    return createWorkspaceDocumentRecord({
        tab: {
            fileName,
            originalPath,
            isDirty: options.canSave ?? true,
            isDjvu: false,
        },
        documentIdentity: createDocumentRevision(revisionToken, documentRef, revisionToken.length),
        toolbarSnapshot: {
            hasPdf: true,
            canSave: options.canSave ?? true,
            currentPage: 1,
            initialVisualReady: true,
            totalPages: 4,
            viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
                pdfDocument: true,
                print: true,
                save: true,
                sidebar: true,
            },
            ...options.toolbarSnapshot,
        },
    });
}

describe('useAppShellTabLifecycle', () => {
    it('keeps split close and retained-pane handoff inside the tab transition', async () => {
        const panes = ref<IEditorPaneState[]>([
            {
                paneId: 'pane-left',
                activeTabId: 'tab-document',
                tabIds: ['tab-document'],
            },
            {
                paneId: 'pane-right',
                activeTabId: 'tab-empty',
                tabIds: ['tab-empty'],
            },
        ]);
        const tabs = ref<ITab[]>([
            {
                id: 'tab-document',
                fileName: 'retained.pdf',
                originalPath: '/docs/retained.pdf',
                isDirty: false,
                isDjvu: false,
            },
            {
                id: 'tab-empty',
                fileName: null,
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            },
        ]);
        const activePaneId = ref('pane-right');
        const activeTabId = ref<string | null>('tab-empty');
        const transitionStates = {
            closeTab: false,
            closePane: false,
            activateRetainedTab: false,
        };
        const getPaneById = (paneId: string | null | undefined) => (
            panes.value.find(pane => pane.paneId === paneId) ?? null
        );
        const getTabById = (tabId: string | null | undefined) => (
            tabs.value.find(tab => tab.id === tabId) ?? null
        );
        const getPaneByTabId = (tabId: string | null | undefined) => (
            panes.value.find(pane => tabId ? pane.tabIds.includes(tabId) : false) ?? null
        );
        const lifecycle = useAppShellTabLifecycle({
            panes,
            tabs,
            activePaneId,
            activeTabId,
            workspaceRefs: ref(new Map()),
            documentSessionsByTabId: shallowRef({}),
            getDocumentRecord: vi.fn(() => null),
            workspaceSplitCache: {
                set: vi.fn(),
                peek: vi.fn(),
                consume: vi.fn(),
                has: vi.fn(() => false),
                clear: vi.fn(),
            },
            workspaceRestoreTracker: {
                start: vi.fn(),
                finish: vi.fn(),
                has: vi.fn(() => false),
            },
            getPaneById,
            getTabById,
            getPaneByTabId,
            activatePane: vi.fn((paneId: string) => {
                activePaneId.value = paneId;
            }),
            activateTab: vi.fn((paneId: string, tabId: string) => {
                transitionStates.activateRetainedTab = lifecycle.isTabTransitionBusy.value;
                activePaneId.value = paneId;
                activeTabId.value = tabId;
            }),
            closeTab: vi.fn((paneId: string, tabId: string) => {
                transitionStates.closeTab = lifecycle.isTabTransitionBusy.value;
                const pane = getPaneById(paneId);
                if (pane) {
                    pane.tabIds = pane.tabIds.filter(candidate => candidate !== tabId);
                    pane.activeTabId = pane.tabIds[0] ?? null;
                }
                tabs.value = tabs.value.filter(tab => tab.id !== tabId);
            }),
            closePane: vi.fn((paneId: string) => {
                transitionStates.closePane = lifecycle.isTabTransitionBusy.value;
                panes.value = panes.value.filter(pane => pane.paneId !== paneId);
            }),
            requestDirtyTabCloseConfirmation: vi.fn(async () => true),
        });
        let publishedBusyState = false;
        const stopWatchingBusyState = watch(lifecycle.isTabTransitionBusy, (isBusy) => {
            publishedBusyState = isBusy;
        }, {flush: 'post'});

        await lifecycle.enqueueTabTransition(async () => {
            expect(publishedBusyState).toBe(true);
        });
        stopWatchingBusyState();

        await lifecycle.handleCloseTab('pane-right', 'tab-empty');

        expect(transitionStates).toEqual({
            closeTab: true,
            closePane: true,
            activateRetainedTab: true,
        });
        expect(activePaneId.value).toBe('pane-left');
        expect(activeTabId.value).toBe('tab-document');
        expect(lifecycle.isTabTransitionBusy.value).toBe(false);
    });

    it('delegates workspace close commands to the document controller transaction', async () => {
        const pane = {
            paneId: 'pane-1',
            activeTabId: 'tab-1',
            tabIds: ['tab-1'],
        };
        const tab = {
            id: 'tab-1',
            fileName: 'sample.pdf',
            originalPath: '/tmp/sample.pdf',
            isDirty: false,
            isDjvu: false,
        };
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
            initialRecord: createWorkspaceDocumentRecord({tab: {
                fileName: tab.fileName,
                originalPath: tab.originalPath,
                isDirty: tab.isDirty,
                isDjvu: tab.isDjvu,
            }}),
            createTransactionId: () => 'close-transaction-1',
        });
        const workspace = cast<IWorkspaceExpose>({
            hasPdf: true,
            getToolbarSnapshot: vi.fn(() => ({viewerCapabilities: {closeableDocument: true}})),
            handleCloseFileFromUi: vi.fn(async () => {
                expect(session.snapshot.value.phase).toBe('closing');
                expect(session.snapshot.value.activeTransaction).toMatchObject({
                    id: 'close-transaction-1',
                    kind: 'close',
                    documentRef: '/tmp/sample.pdf',
                    persist: true,
                });
                return true;
            }),
        });
        session.attachWorkspace(workspace);

        const lifecycle = useAppShellTabLifecycle({
            panes: ref([pane]),
            tabs: ref([tab]),
            activePaneId: ref('pane-1'),
            activeTabId: ref('tab-1'),
            workspaceRefs: ref(new Map([[
                'tab-1',
                workspace,
            ]])),
            documentSessionsByTabId: shallowRef({'tab-1': session}),
            getDocumentRecord: vi.fn(() => null),
            workspaceSplitCache: {
                set: vi.fn(),
                peek: vi.fn(),
                consume: vi.fn(),
                has: vi.fn(() => false),
                clear: vi.fn(),
            },
            workspaceRestoreTracker: {
                start: vi.fn(),
                finish: vi.fn(),
                has: vi.fn(() => false),
            },
            getPaneById: vi.fn((paneId: string | null | undefined) => paneId === 'pane-1' ? pane : null),
            getTabById: vi.fn((tabId: string | null | undefined) => tabId === 'tab-1' ? tab : null),
            getPaneByTabId: vi.fn((tabId: string | null | undefined) => tabId === 'tab-1' ? pane : null),
            activatePane: vi.fn(),
            activateTab: vi.fn(),
            closeTab: vi.fn(),
            closePane: vi.fn(),
            requestDirtyTabCloseConfirmation: vi.fn(async () => true),
        });

        await lifecycle.handleCloseTab('pane-1', 'tab-1');

        expect(workspace.handleCloseFileFromUi).toHaveBeenCalledWith({persist: true});
        expect(session.snapshot.value.activeTransaction).toBeNull();
        expect(session.snapshot.value.phase).toBe('empty');
    });

    it('returns the retained singleton tab to the empty-tab shape after close', async () => {
        const pane = {
            paneId: 'pane-1',
            activeTabId: 'tab-1',
            tabIds: ['tab-1'],
        };
        const tabs = ref<ITab[]>([{
            id: 'tab-1',
            fileName: 'sample.pdf',
            originalPath: '/tmp/sample.pdf',
            isDirty: false,
            isDjvu: false,
        }]);
        const workspaceHasPdf = ref(true);
        let toolbarSnapshot = createReadyRecord('sample.pdf', '/tmp/sample.pdf', {canSave: false}).toolbarSnapshot;
        const workspace = cast<IWorkspaceExpose>({
            hasPdf: workspaceHasPdf,
            getToolbarSnapshot: vi.fn(() => toolbarSnapshot),
            handleCloseFileFromUi: vi.fn(async () => {
                workspaceHasPdf.value = false;
                toolbarSnapshot = createDefaultWorkspaceToolbarSnapshot();
                return true;
            }),
        });
        const workspaceSplitCache = {
            set: vi.fn(),
            peek: vi.fn(),
            consume: vi.fn(),
            has: vi.fn(() => false),
            clear: vi.fn(),
        };
        const closeTab = vi.fn();
        const lifecycle = useAppShellTabLifecycle({
            panes: ref([pane]),
            tabs,
            activePaneId: ref('pane-1'),
            activeTabId: ref<string | null>('tab-1'),
            workspaceRefs: ref(new Map([[
                'tab-1',
                workspace,
            ]])),
            documentSessionsByTabId: shallowRef({}),
            getDocumentRecord: vi.fn(() => null),
            workspaceSplitCache,
            workspaceRestoreTracker: {
                start: vi.fn(),
                finish: vi.fn(),
                has: vi.fn(() => false),
            },
            getPaneById: vi.fn((paneId: string | null | undefined) => paneId === 'pane-1' ? pane : null),
            getTabById: vi.fn((tabId: string | null | undefined) => (
                tabs.value.find(candidate => candidate.id === tabId) ?? null
            )),
            getPaneByTabId: vi.fn((tabId: string | null | undefined) => tabId === 'tab-1' ? pane : null),
            activatePane: vi.fn(),
            activateTab: vi.fn(),
            closeTab,
            closePane: vi.fn(),
            requestDirtyTabCloseConfirmation: vi.fn(async () => true),
        });

        await lifecycle.handleCloseTab('pane-1', 'tab-1');

        expect(closeTab).not.toHaveBeenCalled();
        expect(tabs.value).toHaveLength(1);
        expect(tabs.value[0]).toMatchObject({
            id: 'tab-1',
            fileName: null,
            originalPath: null,
            documentInstanceId: null,
            isDirty: false,
            isDjvu: false,
        });
        expect(tabs.value[0]?.originalBackend).toBeUndefined();
        expect(workspaceSplitCache.clear).toHaveBeenCalledWith('tab-1');
        expect(lifecycle.isSingletonPlaceholderCloseBlocked('pane-1', 'tab-1')).toBe(true);
    });

    it('keeps document, tab, and save projections empty after close despite stale publishes', async () => {
        const panes = ref<IEditorPaneState[]>([{
            paneId: 'pane-1',
            activeTabId: 'tab-1',
            tabIds: ['tab-1'],
        }]);
        const tabs = ref<ITab[]>([{
            id: 'tab-1',
            fileName: 'First.pdf',
            originalPath: '/docs/first.pdf',
            isDirty: false,
            isDjvu: false,
        }]);
        const activePaneId = ref('pane-1');
        const activeTabId = ref<string | null>('tab-1');
        const sessions = useWorkspaceDocumentSessions({
            activeTabId,
            tabs,
        });
        const emptyToolbarSnapshot = createDefaultWorkspaceToolbarSnapshot();
        let workspaceToolbarSnapshot = emptyToolbarSnapshot;
        const workspaceHasPdf = ref(false);
        const workspace = cast<IWorkspaceExpose>({
            hasPdf: workspaceHasPdf,
            getToolbarSnapshot: vi.fn(() => workspaceToolbarSnapshot),
            handleCloseFileFromUi: vi.fn(async () => false),
        });
        sessions.getSession('tab-1')?.attachWorkspace(workspace);

        function getPaneById(paneId: string | null | undefined) {
            return paneId ? panes.value.find(candidate => candidate.paneId === paneId) ?? null : null;
        }

        function getTabById(tabId: string | null | undefined) {
            return tabId ? tabs.value.find(candidate => candidate.id === tabId) ?? null : null;
        }

        function getPaneByTabId(tabId: string | null | undefined) {
            return tabId
                ? panes.value.find(candidate => candidate.tabIds.includes(tabId)) ?? null
                : null;
        }

        function publishWorkspaceRecord(tabId: string, record: IWorkspaceDocumentRecord) {
            sessions.setWorkspaceDocumentRecord(tabId, record);
            const sessionRecord = sessions.getDocumentRecord(tabId) ?? record;
            const tab = getTabById(tabId);
            if (tab) {
                Object.assign(tab, sessionRecord.tab);
            }
        }

        const closeTab = vi.fn((paneId: string, tabId: string) => {
            const pane = getPaneById(paneId);
            if (pane) {
                pane.tabIds = pane.tabIds.filter(candidate => candidate !== tabId);
                if (pane.activeTabId === tabId) {
                    pane.activeTabId = pane.tabIds[0] ?? null;
                    activeTabId.value = pane.activeTabId;
                }
            }
            tabs.value = tabs.value.filter(candidate => candidate.id !== tabId);
        });
        const lifecycle = useAppShellTabLifecycle({
            panes,
            tabs,
            activePaneId,
            activeTabId,
            workspaceRefs: sessions.workspaceRefs,
            documentSessionsByTabId: sessions.documentSessionsByTabId,
            getDocumentRecord: sessions.getDocumentRecord,
            workspaceSplitCache: {
                set: vi.fn(),
                peek: vi.fn(),
                consume: vi.fn(),
                has: vi.fn(() => false),
                clear: vi.fn(),
            },
            workspaceRestoreTracker: {
                start: vi.fn(),
                finish: vi.fn(),
                has: vi.fn(() => false),
            },
            getPaneById,
            getTabById,
            getPaneByTabId,
            activatePane: vi.fn((paneId: string) => {
                activePaneId.value = paneId;
            }),
            activateTab: vi.fn((paneId: string, tabId: string) => {
                const pane = getPaneById(paneId);
                if (pane?.tabIds.includes(tabId)) {
                    pane.activeTabId = tabId;
                    activePaneId.value = paneId;
                    activeTabId.value = tabId;
                }
            }),
            closeTab,
            closePane: vi.fn(),
            requestDirtyTabCloseConfirmation: vi.fn(async () => true),
        });
        const shellState = useWorkspaceShellState({
            activeDocumentRecord: sessions.activeDocumentRecord,
            activeTabId,
            tabs,
        });
        const shellToolbar = useShellWorkspaceToolbar({
            activeDocumentRecord: sessions.activeDocumentRecord,
            hasWorkspaceToolbarContent: ref(false),
        });
        const firstRecord = createReadyRecord('First.pdf', '/docs/first.pdf', {
            documentRef: '/tmp/first-working.pdf',
            revisionToken: 'revision:first',
        });

        workspaceHasPdf.value = true;
        workspaceToolbarSnapshot = firstRecord.toolbarSnapshot;
        publishWorkspaceRecord('tab-1', firstRecord);

        const session = sessions.getSession('tab-1');
        expect(session).not.toBeNull();
        expect(shellState.hasDocument.value).toBe(true);
        expect(shellState.activeWorkspaceCanSave.value).toBe(true);
        expect(shellToolbar.shellToolbarSnapshot.value.canSave).toBe(true);
        expect(session?.snapshot.value.closeable).toBe(true);
        const staleSaveTarget = session!.createCommandTarget();

        const close = session!.beginTransaction({
            kind: 'close',
            documentRef: session!.snapshot.value.identity.documentRef,
            persist: false,
        });
        workspaceHasPdf.value = false;
        workspaceToolbarSnapshot = emptyToolbarSnapshot;
        publishWorkspaceRecord('tab-1', createWorkspaceDocumentRecord());
        session!.finishTransaction(close.id, 'committed');

        expect(session!.snapshot.value.phase).toBe('empty');
        expect(session!.snapshot.value.closeable).toBe(false);
        expect(session!.snapshot.value.identity.documentRef).toBeNull();
        expect(session!.validateCommandTarget(staleSaveTarget).ok).toBe(false);
        expect(shellState.hasDocument.value).toBe(false);
        expect(shellState.activeWorkspaceCanSave.value).toBe(false);
        expect(shellToolbar.shellToolbarSnapshot.value.canSave).toBe(false);
        expect(tabs.value[0]).toMatchObject({
            fileName: null,
            originalPath: null,
            isDirty: false,
        });

        publishWorkspaceRecord('tab-1', firstRecord);

        expect(session!.snapshot.value.phase).toBe('empty');
        expect(session!.snapshot.value.closeable).toBe(false);
        expect(shellState.hasDocument.value).toBe(false);
        expect(shellToolbar.shellToolbarHasPdf.value).toBe(false);
        expect(lifecycle.isSingletonPlaceholderCloseBlocked('pane-1', 'tab-1')).toBe(true);

        await lifecycle.handleCloseTab('pane-1', 'tab-1');
        await nextTick();

        expect(workspace.handleCloseFileFromUi).not.toHaveBeenCalled();
        expect(closeTab).not.toHaveBeenCalled();
        expect(tabs.value).toHaveLength(1);

        const secondRecord = createReadyRecord('Second.pdf', '/docs/second.pdf', {
            documentRef: '/tmp/second-working.pdf',
            revisionToken: 'revision:second',
        });
        const reopen = session!.beginTransaction({
            kind: 'open',
            documentRef: secondRecord.documentIdentity?.documentRef ?? '/tmp/second-working.pdf',
        });
        workspaceHasPdf.value = true;
        workspaceToolbarSnapshot = secondRecord.toolbarSnapshot;
        publishWorkspaceRecord('tab-1', secondRecord);
        session!.finishTransaction(reopen.id, 'committed');

        expect(session!.snapshot.value.phase).toBe('ready');
        expect(session!.snapshot.value.identity.originalPath).toBe('/docs/second.pdf');
        expect(shellState.hasDocument.value).toBe(true);
        expect(shellState.activeWorkspaceCanSave.value).toBe(true);
        expect(shellToolbar.shellToolbarSnapshot.value.canSave).toBe(true);
    });
});
