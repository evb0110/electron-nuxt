import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IAgentTabSnapshot,
    IAgentWorkspaceSnapshot,
} from '@contracts/agent';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import {
    assertAssistantMcpSnapshotMatchesScope,
    clearAssistantMcpSessionScope,
    createAssistantCommandExecutionScope,
    resolveAssistantMcpSessionScope,
    setActiveAssistantMcpSessionScope,
    syncAssistantMcpSessionScope,
} from '@electron/features/agent/assistantMcpSessionScope';
import type { IAssistantSessionScopeBinding } from '@electron/features/agent/assistantTurnLifecycle';
import {
    requireDocumentInstanceId,
    requireDocumentRevisionToken,
} from '@contracts';

const documentIdentity = {
    version: 1,
    documentRef: '/tmp/a.pdf',
    authority: 'electron-working-copy',
    contentRevision: 3,
    token: requireDocumentRevisionToken('revision-token-a'),
    mintedAt: 123,
} satisfies IDocumentRevisionInfo;

const binding = {
    sessionKey: 'codex:document:/tmp/a.pdf',
    scopeKey: 'document:/tmp/a.pdf',
    provider: 'codex',
    turnGeneration: 4,
    windowId: 42,
    tabId: 'tab-a',
    documentSessionKey: 'document:/tmp/a.pdf',
    documentInstanceId: requireDocumentInstanceId('instance-a'),
    documentRef: '/tmp/a.pdf',
    documentIdentity,
} satisfies IAssistantSessionScopeBinding;

const commandTarget = {
    kind: 'revision',
    tabId: 'tab-a',
    sessionId: 'session-a',
    documentRef: '/tmp/a.pdf',
    documentInstanceId: requireDocumentInstanceId('instance-a'),
    sessionRevision: 7,
    documentRevisionToken: requireDocumentRevisionToken('revision-token-a'),
} as const;

function createTab(patch: Partial<IAgentTabSnapshot> = {}): IAgentTabSnapshot {
    return {
        tabId: 'tab-a',
        paneId: 'pane-a',
        fileName: 'a.pdf',
        originalPath: '/tmp/a.pdf',
        kind: 'pdf',
        isDirty: false,
        workspaceAttached: true,
        hasPdf: true,
        isDjvu: false,
        isOpeningDocument: false,
        hasOpenError: false,
        currentPage: 1,
        totalPages: 2,
        readiness: {
            status: 'ready',
            reasons: [],
            recommendations: [],
        },
        documentSessionKey: 'document:/tmp/a.pdf',
        documentInstanceId: requireDocumentInstanceId('instance-a'),
        documentIdentity,
        commandTarget,
        ...patch,
    };
}

function createSnapshot(tab: IAgentTabSnapshot = createTab()): IAgentWorkspaceSnapshot {
    return {
        capturedAt: '2026-01-01T00:00:00.000Z',
        activePaneId: 'pane-a',
        activeTabId: tab.tabId,
        summary: {
            mode: 'open-document',
            activeDocument: {
                tabId: tab.tabId,
                paneId: tab.paneId,
                fileName: tab.fileName,
                originalPath: tab.originalPath,
                kind: tab.kind,
                documentIdentity: tab.documentIdentity ?? null,
                ...(tab.documentSessionKey === undefined ? {} : {documentSessionKey: tab.documentSessionKey}),
                ...(tab.documentInstanceId === undefined ? {} : {documentInstanceId: tab.documentInstanceId}),
                ...(tab.commandTarget === undefined ? {} : {commandTarget: tab.commandTarget}),
            },
            documentCount: 1,
            recentFileCount: 0,
            recentFilesResolved: true,
        },
        panes: [{
            paneId: 'pane-a',
            tabIds: [tab.tabId],
            activeTabId: tab.tabId,
        }],
        tabs: [tab],
        recentFiles: [],
        layout: null,
    };
}

describe('assistantMcpSessionScope', () => {
    afterEach(() => {
        clearAssistantMcpSessionScope();
    });

    it('rejects internal MCP resolution without an active assistant binding', () => {
        expect(() => resolveAssistantMcpSessionScope()).toThrow('No active assistant turn');
    });

    it('rejects explicit window ids that do not match the active assistant binding', () => {
        setActiveAssistantMcpSessionScope(binding);

        expect(() => resolveAssistantMcpSessionScope(41)).toThrow('different window');
        expect(resolveAssistantMcpSessionScope(42)).toMatchObject({
            sessionKey: binding.sessionKey,
            windowId: 42,
        });
    });

    it('validates the bound tab and document revision identity', () => {
        setActiveAssistantMcpSessionScope(binding);
        const staleIdentity = {
            ...documentIdentity,
            token: requireDocumentRevisionToken('revision-token-b'),
        } satisfies IDocumentRevisionInfo;

        expect(() => assertAssistantMcpSnapshotMatchesScope(createSnapshot(), binding)).not.toThrow();
        expect(() => assertAssistantMcpSnapshotMatchesScope(
            createSnapshot(createTab({documentIdentity: staleIdentity})),
            binding,
        )).toThrow('document changed');
        expect(() => assertAssistantMcpSnapshotMatchesScope(
            createSnapshot(createTab({tabId: 'tab-b'})),
            binding,
        )).toThrow('document tab is no longer open');
    });

    it('validates the bound session command target when one is present', () => {
        const scopedBinding = {
            ...binding,
            commandTarget,
        } satisfies IAssistantSessionScopeBinding;

        expect(() => assertAssistantMcpSnapshotMatchesScope(createSnapshot(), scopedBinding)).not.toThrow();
        expect(() => assertAssistantMcpSnapshotMatchesScope(
            createSnapshot(createTab({commandTarget: {
                ...commandTarget,
                sessionRevision: 8,
            }})),
            scopedBinding,
        )).toThrow('document changed');
    });

    it('rejects a same-revision assistant snapshot when the document instance changed', () => {
        const scopedBinding = {
            ...binding,
            commandTarget,
        } satisfies IAssistantSessionScopeBinding;

        expect(() => assertAssistantMcpSnapshotMatchesScope(
            createSnapshot(createTab({
                documentInstanceId: requireDocumentInstanceId('instance-b'),
                commandTarget: {
                    ...commandTarget,
                    documentInstanceId: requireDocumentInstanceId('instance-b'),
                },
            })),
            scopedBinding,
        )).toThrow('document changed');
    });

    it('syncs and clears active bindings by session key', () => {
        syncAssistantMcpSessionScope(binding.sessionKey, binding);
        expect(resolveAssistantMcpSessionScope().sessionKey).toBe(binding.sessionKey);

        clearAssistantMcpSessionScope('other-session');
        expect(resolveAssistantMcpSessionScope().sessionKey).toBe(binding.sessionKey);

        syncAssistantMcpSessionScope(binding.sessionKey, null);
        expect(() => resolveAssistantMcpSessionScope()).toThrow('No active assistant turn');
    });

    it('creates renderer command execution scope from the assistant binding', () => {
        const scopedBinding = {
            ...binding,
            commandTarget,
        } satisfies IAssistantSessionScopeBinding;

        expect(createAssistantCommandExecutionScope(scopedBinding)).toEqual({
            windowId: 42,
            tabId: 'tab-a',
            documentRef: '/tmp/a.pdf',
            documentInstanceId: requireDocumentInstanceId('instance-a'),
            documentIdentity,
            commandTarget,
        });
    });
});
