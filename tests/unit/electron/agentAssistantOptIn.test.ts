import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IAgentAssistantChatScope } from '@contracts/agent';

const mocks = vi.hoisted(() => ({
    loadSettings: vi.fn(async () => ({assistantPanelEnabled: false})),
    getCodexCliInfo: vi.fn(),
    installManagedCodex: vi.fn(),
    spawn: vi.fn(),
    assistantDisabledMessage: 'Enable EVB Assistant in Settings to use assistant chat.',
    startEmbeddedMcpServer: vi.fn(),
    shutdownEmbeddedMcpServer: vi.fn(async () => undefined),
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

class FakeCodexAppServerProcess extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly stdin = {write: (
        line: string,
        callback?: (error?: Error | null) => void,
    ) => {
        this.handleRequestLine(line);
        callback?.();
        return true;
    }};

    private threadCount = 0;
    private turnCount = 0;

    kill = vi.fn(() => {
        this.emit('close', 0);
        return true;
    });

    private handleRequestLine(line: string) {
        const request = JSON.parse(line) as {
            id?: number;
            method?: string;
            params?: { threadId?: string };
        };
        if (request.id === undefined) {
            return;
        }

        switch (request.method) {
            case 'initialize':
                this.respond(request.id, {});
                return;
            case 'account/read':
                this.respond(request.id, {account: {
                    type: 'chatgpt',
                    email: 'reader@example.com',
                }});
                return;
            case 'mcpServerStatus/list':
                this.respond(request.id, {data: [{
                    name: 'evb_viewer_embedded',
                    tools: {},
                }]});
                return;
            case 'thread/start': {
                this.threadCount += 1;
                this.respond(request.id, { thread: { id: `thread-${this.threadCount}` } });
                return;
            }
            case 'turn/start': {
                this.turnCount += 1;
                this.respond(request.id, { turn: { id: `turn-${this.turnCount}` } });
                this.notify('turn/completed', { threadId: request.params?.threadId });
                return;
            }
            default:
                this.respond(request.id, {});
        }
    }

    private respond(id: number, result: unknown) {
        this.stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id,
            result,
        })}\n`);
    }

    private notify(method: string, params: unknown) {
        this.stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            method,
            params,
        })}\n`);
    }
}

vi.mock('electron', () => ({
    app: {
        focus: vi.fn(),
        getVersion: vi.fn(() => '0.0.0-test'),
        getPath: vi.fn(() => '/tmp/evb-viewer-test'),
    },
    BrowserWindow: {
        getAllWindows: vi.fn(() => []),
        getFocusedWindow: vi.fn(() => null),
    },
    shell: {openExternal: vi.fn()},
}));

vi.mock('child_process', () => ({spawn: mocks.spawn}));

vi.mock('@electron/settings', () => ({loadSettings: mocks.loadSettings}));

vi.mock('@electron/te', () => ({te: (key: string) => key === 'dialogs.agentAssistant.disabledMessage' ? mocks.assistantDisabledMessage : key}));

vi.mock('@electron/config', () => ({config: {automation: {noFocus: true}}}));

vi.mock('@electron/features/agent/codexCli', () => ({
    CODEX_APP_INSTALL_URL: 'https://developers.openai.com/codex/app',
    CODEX_STANDALONE_INSTALL_URL: 'https://example.test/install-codex',
    getCodexCliInfo: mocks.getCodexCliInfo,
    installManagedCodex: mocks.installManagedCodex,
}));

vi.mock('@electron/features/agent/mcpServer', () => ({
    getEmbeddedMcpServerDescriptor: vi.fn(() => null),
    isEmbeddedMcpServerRunning: vi.fn(() => false),
    shutdownEmbeddedMcpServer: mocks.shutdownEmbeddedMcpServer,
    startEmbeddedMcpServer: mocks.startEmbeddedMcpServer,
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

describe('agent assistant opt-in gating', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.loadSettings.mockResolvedValue({assistantPanelEnabled: false});
    });

    it('does not discover Codex or start MCP when disabled state is requested', async () => {
        const { getAgentAssistantState } = await import('@electron/features/agent/codexAssistant');

        const state = await getAgentAssistantState();

        expect(state.status.runtimeState).toBe('stopped');
        expect(state.status.mcp.serverRunning).toBe(false);
        expect(mocks.getCodexCliInfo).not.toHaveBeenCalled();
        expect(mocks.startEmbeddedMcpServer).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('rejects assistant chat actions while disabled', async () => {
        const { sendAgentAssistantMessage } = await import('@electron/features/agent/codexAssistant');

        const result = await sendAgentAssistantMessage({text: 'Summarize this document'});

        expect(result.ok).toBe(false);
        expect(result.error).toBe(mocks.assistantDisabledMessage);
        expect(mocks.getCodexCliInfo).not.toHaveBeenCalled();
        expect(mocks.startEmbeddedMcpServer).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('keeps assistant chat messages scoped to the selected document', async () => {
        const documentA: IAgentAssistantChatScope = {
            kind: 'document',
            key: 'document:/tmp/a.pdf',
            title: 'a.pdf',
            documentRef: '/tmp/a.pdf',
        };
        const documentB: IAgentAssistantChatScope = {
            kind: 'document',
            key: 'document:/tmp/b.pdf',
            title: 'b.pdf',
            documentRef: '/tmp/b.pdf',
        };
        mocks.loadSettings.mockResolvedValue({assistantPanelEnabled: true});
        mocks.getCodexCliInfo.mockResolvedValue({
            installed: true,
            path: '/Applications/Codex.app/Contents/Resources/codex',
            version: '0.133.0',
            minimumVersion: '0.133.0',
            isVersionSupported: true,
            managedInstallDir: '/tmp/codex',
        });
        mocks.startEmbeddedMcpServer.mockResolvedValue({
            name: 'evb_viewer_embedded',
            url: 'http://127.0.0.1:9876',
        });
        mocks.spawn.mockImplementation(() => new FakeCodexAppServerProcess());

        const {
            getAgentAssistantState,
            sendAgentAssistantMessage,
        } = await import('@electron/features/agent/codexAssistant');

        const firstResult = await sendAgentAssistantMessage({
            text: 'Question for A',
            scope: documentA,
        });
        expect(firstResult.ok).toBe(true);
        expect(firstResult.state.scope?.key).toBe(documentA.key);
        expect(firstResult.state.messages.map(message => message.text)).toContain('Question for A');

        const emptyDocumentB = await getAgentAssistantState({ scope: documentB });
        expect(emptyDocumentB.scope?.key).toBe(documentB.key);
        expect(emptyDocumentB.messages).toEqual([]);

        const secondResult = await sendAgentAssistantMessage({
            text: 'Question for B',
            scope: documentB,
        });
        expect(secondResult.ok).toBe(true);
        expect(secondResult.state.messages.map(message => message.text)).toContain('Question for B');
        expect(secondResult.state.messages.map(message => message.text)).not.toContain('Question for A');

        const restoredDocumentA = await getAgentAssistantState({ scope: documentA });
        expect(restoredDocumentA.messages.map(message => message.text)).toContain('Question for A');
        expect(restoredDocumentA.messages.map(message => message.text)).not.toContain('Question for B');
    });
});
