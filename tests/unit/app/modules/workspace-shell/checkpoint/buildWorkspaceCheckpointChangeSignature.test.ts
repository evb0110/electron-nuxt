import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    requireDocumentRevisionToken,
    type IDocumentRevisionInfo,
} from '@contracts/documentRevision';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import {
    createWorkspaceDocumentRecord,
    type IWorkspaceDocumentRecord,
} from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { buildWorkspaceCheckpointChangeSignature } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpointChangeSignature';

function createTab(id: string, overrides: Partial<ITab> = {}): ITab {
    return {
        id,
        fileName: `${id}.pdf`,
        originalPath: null,
        isDirty: false,
        isDjvu: false,
        ...overrides,
    };
}

function createIdentity(token: string, contentRevision: number): IDocumentRevisionInfo {
    return {
        version: 1,
        token: requireDocumentRevisionToken(token),
        documentRef: '/doc.pdf' as TDocumentRef,
        authority: 'electron-working-copy',
        contentRevision,
        mintedAt: 0,
    };
}

function createSignatureOptions() {
    const pane: IEditorPaneState = {
        paneId: 'pane-1',
        tabIds: [
            'tab-a',
            'tab-b',
        ],
        activeTabId: 'tab-a',
    };
    return {
        panes: ref([pane]),
        tabs: ref([
            createTab('tab-a'),
            createTab('tab-b'),
        ]),
        layout: ref<TEditorLayoutNode | null>(null),
        activePaneId: ref<string | null>('pane-1'),
        activeTabId: ref<string | null>('tab-a'),
        workspaceRefs: ref(new Map<string, IWorkspaceExpose>()),
        documentRecordsByTabId: ref<Record<string, IWorkspaceDocumentRecord>>({}),
        getPaneByTabId: (): IEditorPaneState | null => pane,
    };
}

describe('buildWorkspaceCheckpointChangeSignature', () => {
    it('is stable across rebuilds of identical state', () => {
        const options = createSignatureOptions();
        const first = buildWorkspaceCheckpointChangeSignature(options);
        const second = buildWorkspaceCheckpointChangeSignature(options);
        expect(second.workspace).toBe(first.workspace);
        expect([...second.tabSignatures.entries()]).toEqual([...first.tabSignatures.entries()]);
    });

    it('changes only the affected tab signature when a document record changes', () => {
        const options = createSignatureOptions();
        const before = buildWorkspaceCheckpointChangeSignature(options);
        options.documentRecordsByTabId.value = {'tab-b': createWorkspaceDocumentRecord({
            tab: {
                fileName: 'tab-b.pdf',
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            },
            toolbarSnapshot: {
                hasPdf: true,
                currentPage: 7,
                totalPages: 30,
            },
        })};
        const after = buildWorkspaceCheckpointChangeSignature(options);
        expect(after.tabSignatures.get('tab-a')).toBe(before.tabSignatures.get('tab-a'));
        expect(after.tabSignatures.get('tab-b')).not.toBe(before.tabSignatures.get('tab-b'));
        expect(after.workspace).not.toBe(before.workspace);
    });

    it('tracks toolbar view state the checkpoint persists', () => {
        const options = createSignatureOptions();
        const record = createWorkspaceDocumentRecord({toolbarSnapshot: {
            hasPdf: true,
            currentPage: 7,
            totalPages: 30,
        }});
        options.documentRecordsByTabId.value = {'tab-a': record};
        const before = buildWorkspaceCheckpointChangeSignature(options);
        options.documentRecordsByTabId.value = {'tab-a': {
            ...record,
            toolbarSnapshot: {
                ...record.toolbarSnapshot,
                currentPage: 8,
            },
        }};
        const after = buildWorkspaceCheckpointChangeSignature(options);
        expect(after.tabSignatures.get('tab-a')).not.toBe(before.tabSignatures.get('tab-a'));
    });

    it('tracks tab dirtiness, mount state, and pane membership', () => {
        const options = createSignatureOptions();
        const base = buildWorkspaceCheckpointChangeSignature(options);

        options.tabs.value = [
            createTab('tab-a', {isDirty: true}),
            createTab('tab-b'),
        ];
        const afterDirty = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterDirty.tabSignatures.get('tab-a')).not.toBe(base.tabSignatures.get('tab-a'));
        expect(afterDirty.tabSignatures.get('tab-b')).toBe(base.tabSignatures.get('tab-b'));

        options.tabs.value = [
            createTab('tab-a'),
            createTab('tab-b'),
        ];
        options.workspaceRefs.value = new Map([[
            'tab-a',
            {} as IWorkspaceExpose,
        ]]);
        const afterMount = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterMount.tabSignatures.get('tab-a')).not.toBe(base.tabSignatures.get('tab-a'));

        options.workspaceRefs.value = new Map();
        const detachedOptions = {
            ...options,
            getPaneByTabId: (): IEditorPaneState | null => null,
        };
        const afterPaneChange = buildWorkspaceCheckpointChangeSignature(detachedOptions);
        expect(afterPaneChange.tabSignatures.get('tab-a')).not.toBe(base.tabSignatures.get('tab-a'));
    });

    it('tracks the document revision identity', () => {
        const options = createSignatureOptions();
        options.documentRecordsByTabId.value = {'tab-a': createWorkspaceDocumentRecord({documentIdentity: createIdentity('token-1', 1)})};
        const before = buildWorkspaceCheckpointChangeSignature(options);
        options.documentRecordsByTabId.value = {'tab-a': createWorkspaceDocumentRecord({documentIdentity: createIdentity('token-1', 2)})};
        const after = buildWorkspaceCheckpointChangeSignature(options);
        expect(after.tabSignatures.get('tab-a')).not.toBe(before.tabSignatures.get('tab-a'));

        options.documentRecordsByTabId.value = {'tab-a': createWorkspaceDocumentRecord({documentIdentity: createIdentity('token-2', 2)})};
        const afterTokenChange = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterTokenChange.tabSignatures.get('tab-a')).not.toBe(after.tabSignatures.get('tab-a'));
    });

    it('changes the workspace signature for workspace-only state', () => {
        const options = createSignatureOptions();
        const before = buildWorkspaceCheckpointChangeSignature(options);

        options.activeTabId.value = 'tab-b';
        const afterActiveTab = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterActiveTab.workspace).not.toBe(before.workspace);
        expect([...afterActiveTab.tabSignatures.entries()]).toEqual([...before.tabSignatures.entries()]);

        options.activeTabId.value = 'tab-a';
        options.panes.value = [{
            paneId: 'pane-1',
            tabIds: [
                'tab-b',
                'tab-a',
            ],
            activeTabId: 'tab-a',
        }];
        const afterTabOrder = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterTabOrder.workspace).not.toBe(before.workspace);
    });
});
