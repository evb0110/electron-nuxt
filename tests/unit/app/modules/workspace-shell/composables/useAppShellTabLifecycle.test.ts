import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import { useAppShellTabLifecycle } from '@app/modules/workspace-shell/composables/useAppShellTabLifecycle';
import { createWorkspaceDocumentSessionCore } from '@app/modules/workspace-shell/document-sessions/createWorkspaceDocumentSessionCore';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { cast } from '@tests/helpers/cast';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';

vi.mock('@app/composables/useRuntimeErrorReports', () => ({useRuntimeErrorReports: () => ({reportRuntimeError: vi.fn()})}));

describe('useAppShellTabLifecycle', () => {
    it('wraps workspace close commands in a document session close transaction', async () => {
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
        const session = createWorkspaceDocumentSessionCore({
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
        const beginTransaction = vi.spyOn(session, 'beginTransaction');
        const finishTransaction = vi.spyOn(session, 'finishTransaction');
        const workspace = cast<IWorkspaceExpose>({
            hasPdf: true,
            getToolbarSnapshot: vi.fn(() => ({viewerCapabilities: {closeableDocument: true}})),
            handleCloseFileFromUi: vi.fn(async () => true),
        });

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

        expect(beginTransaction).toHaveBeenCalledWith({
            kind: 'close',
            documentRef: '/tmp/sample.pdf',
            persist: true,
        });
        expect(workspace.handleCloseFileFromUi).toHaveBeenCalledWith({persist: true});
        expect(finishTransaction).toHaveBeenCalledWith('close-transaction-1', 'committed');
    });
});
