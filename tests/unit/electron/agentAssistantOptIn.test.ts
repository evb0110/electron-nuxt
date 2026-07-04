import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { BrowserWindow } from 'electron';
import type {
    IAgentAssistantChatScope,
    IAgentAssistantEvent,
} from '@contracts/agent';
import type * as CodexAssistantModule from '@electron/features/agent/codexAssistant';
import { cast } from '@tests/helpers/cast';

const mocks = vi.hoisted(() => ({
    loadSettings: vi.fn(async () => ({assistantPanelEnabled: false})),
    getCodexCliInfo: vi.fn(),
    installManagedCodex: vi.fn(),
    spawn: vi.fn(),
    assistantDisabledMessage: 'Enable EVB Assistant in Settings to use assistant chat.',
    startEmbeddedMcpServer: vi.fn(),
    shutdownEmbeddedMcpServer: vi.fn(async () => undefined),
    openExternal: vi.fn(),
    initializeGate: null as null | {
        promise: Promise<void>;
        resolve: () => void;
    },
    turnStartGate: null as null | {
        promise: Promise<void>;
        resolve: () => void;
    },
    codexAccountReadMode: 'success',
    codexAuthStatusMode: 'signed-in',
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
    assistantTurnBusyMessage: 'EVB Assistant is still working on the previous message for this document.',
}));

class FakeCodexAppServerProcess extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly requestMethods: string[] = [];
    readonly stdin = Object.assign(new EventEmitter(), {write: (
        line: string,
        callback?: (error?: Error | null) => void,
    ) => {
        this.handleRequestLine(line);
        callback?.();
        return true;
    }});

    private threadCount = 0;
    private turnCount = 0;

    kill = vi.fn(() => {
        this.emit('close', 0);
        return true;
    });

    notifyAppServer(method: string, params: unknown) {
        this.notify(method, params);
    }

    private handleRequestLine(line: string) {
        const request = JSON.parse(line) as {
            id?: number;
            method?: string;
            params?: {
                threadId?: string;
                input?: Array<{ text?: string }>;
            };
        };
        if (request.id === undefined) {
            return;
        }
        if (request.method) {
            this.requestMethods.push(request.method);
            this.emit('codex-request', request.method);
        }

        switch (request.method) {
            case 'initialize':
                if (mocks.initializeGate) {
                    void mocks.initializeGate.promise.then(() => this.respond(request.id!, {}));
                    return;
                }
                this.respond(request.id, {});
                return;
            case 'account/read':
                if (mocks.codexAccountReadMode === 'error') {
                    this.respondError(request.id, 'account/read timed out after 8000ms.');
                    return;
                }
                if (mocks.codexAccountReadMode === 'signed-out') {
                    this.respond(request.id, {requiresOpenaiAuth: true});
                    return;
                }
                this.respond(request.id, {account: {
                    type: 'chatgpt',
                    email: 'reader@example.com',
                }});
                return;
            case 'getAuthStatus':
                if (mocks.codexAuthStatusMode === 'error') {
                    this.respondError(request.id, 'getAuthStatus timed out after 8000ms.');
                    return;
                }
                this.respond(request.id, mocks.codexAuthStatusMode === 'signed-out'
                    ? {
                        requiresOpenaiAuth: true,
                        authMethod: null,
                    }
                    : {
                        requiresOpenaiAuth: false,
                        authMethod: 'chatgpt',
                    });
                return;
            case 'account/login/start':
                this.respond(request.id, {
                    type: 'chatgpt',
                    loginId: 'login-1',
                    authUrl: 'https://auth.example.test/start',
                });
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
                const turnNumber = this.turnCount;
                const turnId = `turn-${turnNumber}`;
                const assistantId = `assistant-${turnNumber}`;
                const text = request.params?.input?.find(item => typeof item.text === 'string')?.text ?? '';
                if (text.includes('timeout')) {
                    return;
                }
                const finishTurnStart = () => {
                    if (text.includes('early-delta')) {
                        this.notify('item/agentMessage/delta', {
                            threadId: request.params?.threadId,
                            turnId,
                            itemId: assistantId,
                            delta: 'Early ',
                        });
                        this.notify('item/completed', {
                            threadId: request.params?.threadId,
                            turnId,
                            item: {
                                type: 'agentMessage',
                                id: assistantId,
                                text: 'Early answer',
                            },
                        });
                        this.notify('turn/completed', {
                            threadId: request.params?.threadId,
                            turnId,
                        });
                    }
                    this.respond(request.id!, { turn: { id: turnId } });
                    this.notify('turn/started', {
                        threadId: request.params?.threadId,
                        turn: { id: turnId },
                    });
                    if (text.includes('hold-active') || text.includes('early-delta')) {
                        return;
                    }
                    if (text.includes('stream')) {
                        this.notify('item/agentMessage/delta', {
                            threadId: request.params?.threadId,
                            itemId: assistantId,
                            delta: 'Hello ',
                        });
                        this.notify('item/agentMessage/delta', {
                            threadId: request.params?.threadId,
                            itemId: assistantId,
                            delta: 'there',
                        });
                        this.notify('item/completed', {
                            threadId: request.params?.threadId,
                            item: {
                                type: 'agentMessage',
                                id: assistantId,
                                text: 'Hello there',
                            },
                        });
                    }
                    this.notify('turn/completed', { threadId: request.params?.threadId });
                };
                if (mocks.turnStartGate) {
                    void mocks.turnStartGate.promise.then(finishTurnStart);
                    return;
                }
                finishTurnStart();
                return;
            }
            case 'turn/interrupt':
                this.respond(request.id, {});
                return;
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

    private respondError(id: number, message: string) {
        this.stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { message },
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
    shell: {openExternal: mocks.openExternal},
}));

vi.mock('child_process', () => ({
    spawn: mocks.spawn,
    execFile: vi.fn(),
}));

vi.mock('@electron/settings', () => ({loadSettings: mocks.loadSettings}));

vi.mock('@electron/te', () => ({te: (key: string) => {
    if (key === 'dialogs.agentAssistant.disabledMessage') {
        return mocks.assistantDisabledMessage;
    }
    if (key === 'dialogs.agentAssistant.turnBusy') {
        return mocks.assistantTurnBusyMessage;
    }
    return key;
}}));

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

function createInitializeGate() {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((next) => {
        resolve = next;
    });
    return {
        promise,
        resolve,
    };
}

async function waitForCodexRequest(process: FakeCodexAppServerProcess, method: string) {
    if (process.requestMethods.includes(method)) {
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            process.off('codex-request', onRequest);
            reject(new Error(`Timed out waiting for Codex request ${method}`));
        }, 5_000);
        function onRequest(candidate: string) {
            if (candidate !== method) {
                return;
            }
            clearTimeout(timeout);
            process.off('codex-request', onRequest);
            resolve();
        }

        process.on('codex-request', onRequest);
    });
}

async function waitForCodexRequestCount(process: FakeCodexAppServerProcess, method: string, count: number) {
    if (process.requestMethods.filter(candidate => candidate === method).length >= count) {
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            process.off('codex-request', onRequest);
            reject(new Error(`Timed out waiting for Codex request ${method} count ${count}`));
        }, 5_000);
        function onRequest(candidate: string) {
            if (candidate !== method) {
                return;
            }
            if (process.requestMethods.filter(requestMethod => requestMethod === method).length < count) {
                return;
            }
            clearTimeout(timeout);
            process.off('codex-request', onRequest);
            resolve();
        }

        process.on('codex-request', onRequest);
    });
}

async function settleAsyncTicks(count = 3) {
    for (let index = 0; index < count; index += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

describe('agent assistant opt-in gating', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.loadSettings.mockResolvedValue({assistantPanelEnabled: false});
        mocks.initializeGate = null;
        mocks.turnStartGate = null;
        mocks.codexAccountReadMode = 'success';
        mocks.codexAuthStatusMode = 'signed-in';
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    it('does not discover Codex or start MCP when disabled state is requested', async () => {
        const { getAgentAssistantState }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const state = await getAgentAssistantState();

        expect(state.status.runtimeState).toBe('stopped');
        expect(state.status.mcp.serverRunning).toBe(false);
        expect(mocks.getCodexCliInfo).not.toHaveBeenCalled();
        expect(mocks.startEmbeddedMcpServer).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('rejects assistant chat actions while disabled', async () => {
        const { sendAgentAssistantMessage }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const result = await sendAgentAssistantMessage({text: 'Summarize this document'});

        expect(result.ok).toBe(false);
        expect(result.error).toBe(mocks.assistantDisabledMessage);
        expect(result.errorEnvelope).toMatchObject({
            code: 'INTERNAL',
            message: mocks.assistantDisabledMessage,
            retryable: false,
        });
        expect(mocks.getCodexCliInfo).not.toHaveBeenCalled();
        expect(mocks.startEmbeddedMcpServer).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('falls back to Codex auth status when account profile read fails', async () => {
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
            descriptor: {
                name: 'evb_viewer_embedded',
                url: 'http://127.0.0.1:9876',
            },
            token: 'test-mcp-token',
        });
        mocks.codexAccountReadMode = 'error';
        mocks.codexAuthStatusMode = 'signed-in';
        mocks.spawn.mockImplementation(() => new FakeCodexAppServerProcess());

        const { getAgentAssistantState }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const state = await getAgentAssistantState();

        expect(state.status.authState).toBe('signed-in');
        expect(state.status.runtimeState).toBe('ready');
        expect(state.status.account).toBeNull();
        expect(state.status.error).toBeUndefined();
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('falling back to auth status'));
    });

    it('publishes an actionable auth error when Codex auth probes fail', async () => {
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
            descriptor: {
                name: 'evb_viewer_embedded',
                url: 'http://127.0.0.1:9876',
            },
            token: 'test-mcp-token',
        });
        mocks.codexAccountReadMode = 'error';
        mocks.codexAuthStatusMode = 'error';
        mocks.spawn.mockImplementation(() => new FakeCodexAppServerProcess());

        const { getAgentAssistantState }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const state = await getAgentAssistantState();

        expect(state.status.authState).toBe('signed-out');
        expect(state.status.runtimeState).toBe('stopped');
        expect(state.status.error).toContain('Could not verify Codex authentication');
        expect(state.status.error).toContain('account/read timed out');
        expect(state.status.error).toContain('getAuthStatus timed out');
    });

    it('waits for in-flight Codex runtime startup before reusing the app-server client', async () => {
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
            descriptor: {
                name: 'evb_viewer_embedded',
                url: 'http://127.0.0.1:9876',
            },
            token: 'test-mcp-token',
        });
        mocks.initializeGate = createInitializeGate();
        const process = new FakeCodexAppServerProcess();
        mocks.spawn.mockImplementation(() => process);

        const { getAgentAssistantState }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const firstState = getAgentAssistantState();
        await waitForCodexRequest(process, 'initialize');
        const secondState = getAgentAssistantState();
        await settleAsyncTicks();

        expect(process.requestMethods).toEqual(['initialize']);
        mocks.initializeGate.resolve();

        await expect(Promise.all([
            firstState,
            secondState,
        ])).resolves.toHaveLength(2);
        expect(mocks.spawn).toHaveBeenCalledOnce();
    });

    it('keeps assistant chat messages scoped to the selected document', async () => {
        const documentA = {
            kind: 'document',
            key: 'document-session:session-a',
            title: 'a.pdf',
            documentRef: '/tmp/shared.pdf',
        } as const satisfies IAgentAssistantChatScope;
        const documentB = {
            kind: 'document',
            key: 'document-session:session-b',
            title: 'a.pdf',
            documentRef: '/tmp/shared.pdf',
        } as const satisfies IAgentAssistantChatScope;
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
            descriptor: {
                name: 'evb_viewer_embedded',
                url: 'http://127.0.0.1:9876',
            },
            token: 'test-mcp-token',
        });
        mocks.spawn.mockImplementation(() => new FakeCodexAppServerProcess());

        const codexAssistantModule: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');
        const {
            getAgentAssistantState,
            sendAgentAssistantMessage,
        } = codexAssistantModule;

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

    it('rejects concurrent sends for the same document session', async () => {
        const documentScope = {
            kind: 'document',
            key: 'document:/tmp/busy.pdf',
            title: 'busy.pdf',
            documentRef: '/tmp/busy.pdf',
        } as const satisfies IAgentAssistantChatScope;
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
            descriptor: {
                name: 'evb_viewer_embedded',
                url: 'http://127.0.0.1:9876',
            },
            token: 'test-mcp-token',
        });
        const process = new FakeCodexAppServerProcess();
        mocks.spawn.mockImplementation(() => process);
        mocks.turnStartGate = createInitializeGate();

        const { sendAgentAssistantMessage }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const firstSend = sendAgentAssistantMessage({
            text: 'Hold this turn',
            scope: documentScope,
        });
        await waitForCodexRequestCount(process, 'turn/start', 1);

        const secondResult = await sendAgentAssistantMessage({
            text: 'Second message',
            scope: documentScope,
        });

        expect(secondResult.ok).toBe(false);
        expect(secondResult.error).toBe(mocks.assistantTurnBusyMessage);
        expect(process.requestMethods.filter(method => method === 'turn/start')).toHaveLength(1);

        mocks.turnStartGate.resolve();
        mocks.turnStartGate = null;
        await expect(firstSend).resolves.toMatchObject({ ok: true });
    });

    it('rejects sends while the previous Codex turn is still active after setup', async () => {
        const documentScope = {
            kind: 'document',
            key: 'document:/tmp/active-turn.pdf',
            title: 'active-turn.pdf',
            documentRef: '/tmp/active-turn.pdf',
        } as const satisfies IAgentAssistantChatScope;
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
            descriptor: {
                name: 'evb_viewer_embedded',
                url: 'http://127.0.0.1:9876',
            },
            token: 'test-mcp-token',
        });
        const process = new FakeCodexAppServerProcess();
        mocks.spawn.mockImplementation(() => process);

        const {
            getAgentAssistantState,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        await expect(sendAgentAssistantMessage({
            text: 'hold-active',
            scope: documentScope,
        })).resolves.toMatchObject({ ok: true });

        const runningState = await getAgentAssistantState({ scope: documentScope });
        expect(runningState.status.turn.phase).toBe('running');

        const secondResult = await sendAgentAssistantMessage({
            text: 'Second message after setup',
            scope: documentScope,
        });

        expect(secondResult.ok).toBe(false);
        expect(secondResult.error).toBe(mocks.assistantTurnBusyMessage);
        expect(process.requestMethods.filter(method => method === 'turn/start')).toHaveLength(1);
    });

    it('binds early Codex deltas before turn-started arrives', async () => {
        const documentScope = {
            kind: 'document',
            key: 'document:/tmp/early-delta.pdf',
            title: 'early-delta.pdf',
            documentRef: '/tmp/early-delta.pdf',
        } as const satisfies IAgentAssistantChatScope;
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
            descriptor: {
                name: 'evb_viewer_embedded',
                url: 'http://127.0.0.1:9876',
            },
            token: 'test-mcp-token',
        });
        const process = new FakeCodexAppServerProcess();
        mocks.spawn.mockImplementation(() => process);

        const { sendAgentAssistantMessage }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const result = await sendAgentAssistantMessage({
            text: 'early-delta',
            scope: documentScope,
        });

        expect(result.ok).toBe(true);
        expect(result.state.status.turn.phase).toBe('idle');
        expect(result.state.messages.map(message => message.text)).toContain('Early answer');
    });

    it('keeps interrupted Codex turns busy until a terminal provider event arrives', async () => {
        const documentScope = {
            kind: 'document',
            key: 'document:/tmp/interrupt.pdf',
            title: 'interrupt.pdf',
            documentRef: '/tmp/interrupt.pdf',
        } as const satisfies IAgentAssistantChatScope;
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
            descriptor: {
                name: 'evb_viewer_embedded',
                url: 'http://127.0.0.1:9876',
            },
            token: 'test-mcp-token',
        });
        const process = new FakeCodexAppServerProcess();
        mocks.spawn.mockImplementation(() => process);

        const {
            getAgentAssistantState,
            interruptAgentAssistant,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        await expect(sendAgentAssistantMessage({
            text: 'hold-active',
            scope: documentScope,
        })).resolves.toMatchObject({ ok: true });

        const interruptedState = await interruptAgentAssistant({ scope: documentScope });
        expect(interruptedState.status.turn.phase).toBe('interrupting');
        expect(interruptedState.status.runtimeState).toBe('busy');

        const blockedResult = await sendAgentAssistantMessage({
            text: 'new turn too early',
            scope: documentScope,
        });
        expect(blockedResult.ok).toBe(false);
        expect(blockedResult.error).toBe(mocks.assistantTurnBusyMessage);

        process.notifyAppServer('turn/completed', {
            threadId: 'thread-1',
            turnId: 'turn-1',
        });
        await settleAsyncTicks();

        const completedState = await getAgentAssistantState({ scope: documentScope });
        expect(completedState.status.turn.phase).toBe('idle');
    });

    it('ignores no-thread Codex completion while a new turn is starting', async () => {
        const documentScope = {
            kind: 'document',
            key: 'document:/tmp/no-thread-completion.pdf',
            title: 'no-thread-completion.pdf',
            documentRef: '/tmp/no-thread-completion.pdf',
        } as const satisfies IAgentAssistantChatScope;
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
            descriptor: {
                name: 'evb_viewer_embedded',
                url: 'http://127.0.0.1:9876',
            },
            token: 'test-mcp-token',
        });
        const process = new FakeCodexAppServerProcess();
        mocks.spawn.mockImplementation(() => process);

        const {
            getAgentAssistantState,
            resetAgentAssistantChat,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        await expect(sendAgentAssistantMessage({
            text: 'First completed turn',
            scope: documentScope,
        })).resolves.toMatchObject({ ok: true });
        await resetAgentAssistantChat({ scope: documentScope });

        mocks.turnStartGate = createInitializeGate();
        const secondSend = sendAgentAssistantMessage({
            text: 'Second starting turn',
            scope: documentScope,
        });
        await waitForCodexRequestCount(process, 'turn/start', 2);

        process.notifyAppServer('turn/completed', {});
        await settleAsyncTicks();

        const state = await getAgentAssistantState({ scope: documentScope });
        expect(state.status.turn.phase).toBe('starting');

        mocks.turnStartGate.resolve();
        mocks.turnStartGate = null;
        await expect(secondSend).resolves.toMatchObject({ ok: true });
    });

    it('archives timed-out Codex turns and ignores late notifications for the old thread', async () => {
        vi.useFakeTimers();
        const documentScope = {
            kind: 'document',
            key: 'document:/tmp/timeout.pdf',
            title: 'timeout.pdf',
            documentRef: '/tmp/timeout.pdf',
        } as const satisfies IAgentAssistantChatScope;
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
            descriptor: {
                name: 'evb_viewer_embedded',
                url: 'http://127.0.0.1:9876',
            },
            token: 'test-mcp-token',
        });
        const process = new FakeCodexAppServerProcess();
        mocks.spawn.mockImplementation(() => process);

        const {
            getAgentAssistantState,
            sendAgentAssistantMessage,
        }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const resultPromise = sendAgentAssistantMessage({
            text: 'please timeout',
            scope: documentScope,
        });
        await waitForCodexRequestCount(process, 'turn/start', 1);
        await vi.advanceTimersByTimeAsync(30_000);

        const result = await resultPromise;
        expect(result.ok).toBe(false);
        expect(result.error).toBe('turn/start timed out after 30000ms.');
        expect(process.requestMethods).toContain('thread/archive');
        vi.useRealTimers();

        process.notifyAppServer('item/completed', {
            threadId: 'thread-1',
            item: {
                type: 'agentMessage',
                id: 'late-message',
                text: 'late text',
            },
        });
        process.notifyAppServer('turn/completed', { threadId: 'thread-1' });
        await settleAsyncTicks();

        const state = await getAgentAssistantState({ scope: documentScope });
        expect(state.messages.map(message => message.text)).not.toContain('late text');
    });

    it('starts fresh Codex threads for inactive document sessions after app-server exit', async () => {
        const documentA = {
            kind: 'document',
            key: 'document:/tmp/a.pdf',
            title: 'a.pdf',
            documentRef: '/tmp/a.pdf',
        } as const satisfies IAgentAssistantChatScope;
        const documentB = {
            kind: 'document',
            key: 'document:/tmp/b.pdf',
            title: 'b.pdf',
            documentRef: '/tmp/b.pdf',
        } as const satisfies IAgentAssistantChatScope;
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
            descriptor: {
                name: 'evb_viewer_embedded',
                url: 'http://127.0.0.1:9876',
            },
            token: 'test-mcp-token',
        });
        const processes: FakeCodexAppServerProcess[] = [];
        mocks.spawn.mockImplementation(() => {
            const process = new FakeCodexAppServerProcess();
            processes.push(process);
            return process;
        });

        const { sendAgentAssistantMessage }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        await expect(sendAgentAssistantMessage({
            text: 'Question for A',
            scope: documentA,
        })).resolves.toMatchObject({ ok: true });
        await expect(sendAgentAssistantMessage({
            text: 'Question for B',
            scope: documentB,
        })).resolves.toMatchObject({ ok: true });
        expect(processes).toHaveLength(1);

        processes[0]?.emit('close', 1);
        await settleAsyncTicks();

        await expect(sendAgentAssistantMessage({
            text: 'Follow-up for A',
            scope: documentA,
        })).resolves.toMatchObject({ ok: true });

        expect(processes).toHaveLength(2);
        const restartedMethods = processes[1]?.requestMethods ?? [];
        expect(restartedMethods).toContain('thread/start');
        expect(restartedMethods.indexOf('thread/start')).toBeLessThan(restartedMethods.indexOf('turn/start'));
    });

    it('evicts least-recently-used idle document chat sessions', async () => {
        vi.stubEnv('EVB_ASSISTANT_CHAT_SESSION_MAX_ENTRIES', '2');
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const documentA = {
            kind: 'document',
            key: 'document:/tmp/a.pdf',
            title: 'a.pdf',
            documentRef: '/tmp/a.pdf',
        } as const satisfies IAgentAssistantChatScope;
        const documentB = {
            kind: 'document',
            key: 'document:/tmp/b.pdf',
            title: 'b.pdf',
            documentRef: '/tmp/b.pdf',
        } as const satisfies IAgentAssistantChatScope;
        const documentC = {
            kind: 'document',
            key: 'document:/tmp/c.pdf',
            title: 'c.pdf',
            documentRef: '/tmp/c.pdf',
        } as const satisfies IAgentAssistantChatScope;
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
            descriptor: {
                name: 'evb_viewer_embedded',
                url: 'http://127.0.0.1:9876',
            },
            token: 'test-mcp-token',
        });
        mocks.spawn.mockImplementation(() => new FakeCodexAppServerProcess());

        try {
            const codexAssistantModule: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');
            const {
                getAgentAssistantState,
                interruptAgentAssistant,
                sendAgentAssistantMessage,
            } = codexAssistantModule;

            await sendAgentAssistantMessage({
                text: 'Question for A',
                scope: documentA,
            });
            await interruptAgentAssistant({ scope: documentA });
            nowSpy.mockReturnValue(1_000_100);
            await sendAgentAssistantMessage({
                text: 'Question for B',
                scope: documentB,
            });
            await interruptAgentAssistant({ scope: documentB });
            nowSpy.mockReturnValue(1_000_200);
            await getAgentAssistantState({ scope: documentA });
            nowSpy.mockReturnValue(1_000_300);
            await sendAgentAssistantMessage({
                text: 'Question for C',
                scope: documentC,
            });

            nowSpy.mockReturnValue(1_000_400);
            const restoredDocumentA = await getAgentAssistantState({ scope: documentA });
            expect(restoredDocumentA.messages.map(message => message.text)).toContain('Question for A');

            nowSpy.mockReturnValue(1_000_500);
            const restoredDocumentB = await getAgentAssistantState({ scope: documentB });
            expect(restoredDocumentB.messages).toEqual([]);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('sanitizes assistant login URLs before opening them externally', async () => {
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
            descriptor: {
                name: 'evb_viewer_embedded',
                url: 'http://127.0.0.1:9876',
            },
            token: 'test-mcp-token',
        });
        mocks.spawn.mockImplementation(() => new FakeCodexAppServerProcess());

        const { startAgentAssistantLogin }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');

        const result = await startAgentAssistantLogin({mode: 'chatgpt'});

        expect(result.ok).toBe(true);
        expect(mocks.openExternal).toHaveBeenCalledWith('https://auth.example.test/start');
    });

    it('keeps streaming assistant deltas lean while boundary events carry state', async () => {
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
            descriptor: {
                name: 'evb_viewer_embedded',
                url: 'http://127.0.0.1:9876',
            },
            token: 'test-mcp-token',
        });
        mocks.spawn.mockImplementation(() => new FakeCodexAppServerProcess());
        const send = vi.fn<(channel: string, event: IAgentAssistantEvent) => void>();
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([cast<BrowserWindow>({
            isDestroyed: () => false,
            webContents: {
                isDestroyed: () => false,
                send,
            },
        })]);
        const documentScope = {
            kind: 'document',
            key: 'document:/tmp/stream.pdf',
            title: 'stream.pdf',
            documentRef: '/tmp/stream.pdf',
        } as const satisfies IAgentAssistantChatScope;

        const { sendAgentAssistantMessage }: typeof CodexAssistantModule = await import('@electron/features/agent/codexAssistant');
        const result = await sendAgentAssistantMessage({
            text: 'please stream',
            scope: documentScope,
        });

        expect(result.ok).toBe(true);
        const events = send.mock.calls.map((call) => call[1]);
        const deltaEvents = events.filter(event => event.type === 'message-delta');
        expect(deltaEvents).toHaveLength(2);
        expect(deltaEvents.every(event => event.state === undefined)).toBe(true);
        expect(events.find(event => event.type === 'turn-completed')?.state).toBeDefined();
    });
});
