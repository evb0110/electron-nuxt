import {
    mkdir,
    writeFile,
} from 'fs/promises';
import {
    spawn,
    type ChildProcessWithoutNullStreams,
} from 'child_process';
import {
    randomBytes,
    randomUUID,
} from 'crypto';
import { join } from 'path';
import {
    BrowserWindow,
    app,
    shell,
} from 'electron';
import { config } from '@electron/config';
import type {
    IAgentAssistantAccount,
    IAgentAssistantChatScope,
    IAgentAssistantChatMessage,
    IAgentAssistantEvent,
    IAgentAssistantImageAttachment,
    IAgentAssistantInstallResult,
    IAgentAssistantLoginRequest,
    IAgentAssistantLoginResult,
    IAgentAssistantScopedRequest,
    IAgentAssistantSendMessageRequest,
    IAgentAssistantSendMessageResult,
    IAgentAssistantState,
    IAgentAssistantStateRequest,
    IAgentAssistantStatus,
    TAgentAssistantAuthState,
    TAgentAssistantRuntimeState,
    TAgentAssistantTurnPhase,
} from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';
import {
    CODEX_APP_INSTALL_URL,
    CODEX_STANDALONE_INSTALL_URL,
    getCodexCliInfo,
    installManagedCodex,
    type ICodexCliInfo,
} from '@electron/features/agent/codexCli';
import {
    getEmbeddedMcpServerDescriptor,
    isEmbeddedMcpServerRunning,
    shutdownEmbeddedMcpServer,
    startEmbeddedMcpServer,
} from '@electron/features/agent/mcpServer';
import { CORE_IPC_EVENT_CHANNELS } from '@electron/ipc/coreContract';
import { loadSettings } from '@electron/settings';
import { te } from '@electron/i18n';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('agent-codex-assistant');
const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const ASSISTANT_IMAGE_ONLY_PROMPT = 'Please answer using the attached image.';
const ASSISTANT_MAX_IMAGE_ATTACHMENTS = 8;
const ASSISTANT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ASSISTANT_MCP_SERVER_NAME = 'evb_viewer_embedded';
const ASSISTANT_MCP_TOKEN_ENV = 'EVB_MCP_TOKEN';
const ASSISTANT_MODEL_CONFIG_DIR = 'assistant';
const ASSISTANT_ROLE_PROMPT = [
    'You are EVB Assistant, a concise assistant embedded in EVB Viewer for researchers working with local documents.',
    'Help with the live EVB Viewer workspace. A document may be absent; inspect workspace state before answering questions that depend on open tabs, current pages, or document contents.',
    'Use only the EVB Viewer MCP tools available in this session. Do not use local files, shell commands, browser automation, web search, or external services.',
    'Use the compact EVB workflow: evb_workspace_snapshot for state, evb_list_capabilities for actions, evb_describe_capability for schemas and policies, evb_read_resource for document resources, evb_run_action for viewer actions, and evb_job_status only for job ids.',
    'Prefer semantic capabilities over toolbar manipulation: document.search, document.read_pages, document.capture_page_image, annotation.create_text_markup, annotation.create_note_at_point, annotation.create_shape, annotation.update_note, annotation.update_text_markup_color, page_labels.preview, page_labels.apply_plan, bookmarks.preview_tree, bookmarks.apply_plan, and file.save after verified writes.',
    'For write, destructive, or long-running work, inspect policy and availability first and use dryRun or preview unless the user intent is already explicit. OCR start requires an explicit user request or approved policy.',
    'Recent files are metadata only. Do not infer their contents until a file is opened and read through EVB tools. When searchable PDF text is missing, say OCR or conversion is needed instead of guessing.',
    'Be concise, cite page numbers when tools provide them, and navigate the viewer only when it directly helps.',
].join('\n');
const ASSISTANT_MCP_TOOLS = [
    'evb_workspace_snapshot',
    'evb_list_capabilities',
    'evb_describe_capability',
    'evb_read_resource',
    'evb_run_action',
    'evb_job_status',
];

type TJsonRpcId = number;

interface IJsonRpcResponse {
    id?: unknown;
    result?: unknown;
    error?: {
        code?: number;
        message?: string;
        data?: unknown;
    };
}

interface IJsonRpcNotification {
    method?: unknown;
    params?: unknown;
}

interface IPendingAppServerRequest {
    method: string;
    timeout: NodeJS.Timeout;
    resolve(value: unknown): void;
    reject(error: Error): void;
}

interface IAssistantRuntime {
    client: CodexAppServerClient;
    codexPath: string;
    codeHome: string;
    cwd: string;
    mcpToken: string;
}

interface IAssistantChatSession {
    scope: IAgentAssistantChatScope;
    threadId: string | null;
    activeTurnId: string | null;
    turnPhase: TAgentAssistantTurnPhase;
    messages: IAgentAssistantChatMessage[];
    lastError?: string;
}

class CodexAppServerClient {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<TJsonRpcId, IPendingAppServerRequest>();
    private nextId = 1;
    private stdoutBuffer = '';
    private stderrBuffer = '';
    private closed = false;

    constructor(
        codexPath: string,
        env: NodeJS.ProcessEnv,
        cwd: string,
        private readonly onNotification: (notification: IJsonRpcNotification) => void,
        private readonly onExit: (message: string) => void,
    ) {
        this.child = spawn(codexPath, [
            'app-server',
            '--listen',
            'stdio://',
        ], {
            cwd,
            env,
            windowsHide: true,
        });

        this.child.stdout.setEncoding('utf8');
        this.child.stderr.setEncoding('utf8');
        this.child.stdout.on('data', chunk => this.handleStdout(chunk));
        this.child.stderr.on('data', chunk => this.handleStderr(chunk));
        this.child.on('error', error => this.failAll(`Codex app-server failed: ${getErrorMessage(error)}`));
        this.child.on('close', (exitCode) => {
            const detail = this.stderrBuffer.trim();
            this.failAll(`Codex app-server exited${exitCode === null ? '' : ` with code ${exitCode}`}${detail ? `: ${detail}` : '.'}`);
        });
    }

    async initialize() {
        await this.request('initialize', {
            clientInfo: {
                name: 'evb-viewer',
                title: 'EVB Viewer',
                version: app.getVersion(),
            },
            capabilities: { experimentalApi: true },
        });
        this.notify('initialized');
    }

    request(method: string, params: unknown, timeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS) {
        if (this.closed) {
            return Promise.reject(new Error('Codex app-server is not running.'));
        }

        const id = this.nextId;
        this.nextId += 1;
        const payload = {
            jsonrpc: '2.0',
            id,
            method,
            params,
        };

        return new Promise<unknown>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
            }, timeoutMs);
            this.pending.set(id, {
                method,
                timeout,
                resolve,
                reject,
            });

            this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
                if (!error) {
                    return;
                }
                const pending = this.pending.get(id);
                if (!pending) {
                    return;
                }
                clearTimeout(pending.timeout);
                this.pending.delete(id);
                pending.reject(new Error(`Failed to send ${method}: ${getErrorMessage(error)}`));
            });
        });
    }

    notify(method: string, params?: unknown) {
        if (this.closed) {
            return;
        }

        const payload = params === undefined
            ? {
                jsonrpc: '2.0',
                method,
            }
            : {
                jsonrpc: '2.0',
                method,
                params,
            };
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    }

    respond(id: unknown, result: unknown) {
        if (this.closed) {
            return;
        }

        this.child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id,
            result,
        })}\n`);
    }

    shutdown() {
        this.closed = true;
        for (const [
            id,
            pending,
        ] of this.pending) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Codex app-server is shutting down.'));
            this.pending.delete(id);
        }
        this.child.kill();
    }

    private handleStdout(chunk: string) {
        this.stdoutBuffer += chunk;
        const lines = this.stdoutBuffer.split(/\r?\n/u);
        this.stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            this.handleMessage(trimmed);
        }
    }

    private handleStderr(chunk: string) {
        this.stderrBuffer += chunk;
        const lines = chunk.split(/\r?\n/u)
            .map(line => line.trim())
            .filter(Boolean);
        for (const line of lines) {
            logger.info(`[app-server] ${line}`);
        }
    }

    private handleMessage(line: string) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch (error) {
            logger.warn(`Ignoring non-JSON app-server output: ${getErrorMessage(error)}`);
            return;
        }

        if (!isRecord(parsed)) {
            return;
        }

        if (typeof parsed.id === 'number' && !('method' in parsed)) {
            this.handleResponse(parsed);
            return;
        }

        if (typeof parsed.method === 'string' && 'id' in parsed) {
            this.handleServerRequest(parsed);
            return;
        }

        if (typeof parsed.method === 'string') {
            this.onNotification(parsed);
        }
    }

    private handleResponse(response: IJsonRpcResponse) {
        const id = typeof response.id === 'number' ? response.id : null;
        if (id === null) {
            return;
        }

        const pending = this.pending.get(id);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timeout);
        this.pending.delete(id);
        if (response.error) {
            pending.reject(new Error(response.error.message || `${pending.method} failed.`));
            return;
        }
        pending.resolve(response.result);
    }

    private handleServerRequest(request: Record<string, unknown>) {
        const method = typeof request.method === 'string' ? request.method : '';
        logger.warn(`Denying unexpected Codex app-server request: ${method}`);
        if (method === 'item/commandExecution/requestApproval') {
            this.respond(request.id, { decision: 'denied' });
            return;
        }
        if (method === 'item/fileChange/requestApproval') {
            this.respond(request.id, { decision: 'denied' });
            return;
        }
        if (method === 'item/tool/call') {
            this.respond(request.id, {
                contentItems: [{
                    type: 'text',
                    text: 'EVB Assistant does not expose dynamic tools.',
                }],
                success: false,
            });
            return;
        }
        if (method === 'mcpServer/elicitation/request') {
            this.respond(request.id, { action: 'decline' });
            return;
        }
        this.respond(request.id, null);
    }

    private failAll(message: string) {
        if (this.closed) {
            return;
        }

        this.closed = true;
        for (const [
            id,
            pending,
        ] of this.pending) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(message));
            this.pending.delete(id);
        }
        this.onExit(message);
    }
}

let codexInfoCache: ICodexCliInfo | null = null;
let runtime: IAssistantRuntime | null = null;
let runtimeState: TAgentAssistantRuntimeState = 'stopped';
let turnPhase: TAgentAssistantTurnPhase = 'idle';
let authState: TAgentAssistantAuthState = 'unknown';
let account: IAgentAssistantAccount | null = null;
let activeChatKey: string | null = null;
let activeTurnId: string | null = null;
let lastStateScope: IAgentAssistantChatScope | null = null;
let pendingLoginId: string | null = null;
let authReturnWindow: BrowserWindow | null = null;
let lastError: string | undefined;
let installPromise: Promise<IAgentAssistantInstallResult> | null = null;
const chatSessions = new Map<string, IAssistantChatSession>();

function rememberAssistantReturnWindow(parentWindow?: BrowserWindow | null) {
    authReturnWindow = parentWindow && !parentWindow.isDestroyed()
        ? parentWindow
        : BrowserWindow.getFocusedWindow();
}

function focusAssistantReturnWindow() {
    const window = authReturnWindow && !authReturnWindow.isDestroyed()
        ? authReturnWindow
        : BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
    authReturnWindow = null;
    if (!window || window.isDestroyed() || config.automation.noFocus) {
        return;
    }
    if (window.isMinimized()) {
        window.restore();
    }
    if (!window.isVisible()) {
        window.show();
    }
    window.focus();
    if (process.platform === 'darwin') {
        app.focus({ steal: true });
    }
}

function getAssistantBaseDir() {
    return join(app.getPath('userData'), ASSISTANT_MODEL_CONFIG_DIR);
}

function getAssistantCodexHome() {
    return join(getAssistantBaseDir(), 'codex-home');
}

function getAssistantCwd() {
    return join(getAssistantBaseDir(), 'cwd');
}

function createMcpToken() {
    return randomBytes(32).toString('hex');
}

async function isAssistantFeatureEnabled() {
    const settings = await loadSettings();
    return settings.assistantPanelEnabled;
}

function createAssistantDisabledError() {
    return te('dialogs.agentAssistant.disabledMessage');
}

function markAssistantDisabledError() {
    const error = createAssistantDisabledError();
    lastError = error;
    runtimeState = 'stopped';
    turnPhase = 'idle';
    activeTurnId = null;
    return error;
}

async function stopAssistantForDisabledFeature() {
    await shutdownAgentAssistant();
    return markAssistantDisabledError();
}

function cloneAssistantScope(scope: IAgentAssistantChatScope): IAgentAssistantChatScope {
    return {
        kind: scope.kind,
        key: scope.key,
        title: scope.title,
        ...(scope.tabId == null ? {} : { tabId: scope.tabId }),
        ...(scope.documentRef == null ? {} : { documentRef: scope.documentRef }),
    };
}

function normalizeAssistantScope(scope: IAgentAssistantChatScope | null | undefined) {
    if (!scope || scope.kind !== 'document') {
        return null;
    }

    const key = scope.key.trim();
    if (!key) {
        return null;
    }

    const title = scope.title?.trim() || null;
    return {
        kind: 'document',
        key,
        title,
        ...(scope.tabId?.trim() ? { tabId: scope.tabId.trim() } : {}),
        ...(scope.documentRef?.trim() ? { documentRef: scope.documentRef.trim() } : {}),
    } satisfies IAgentAssistantChatScope;
}

function resolveRequestedScope(request?: IAgentAssistantStateRequest | IAgentAssistantScopedRequest | null) {
    return normalizeAssistantScope(request?.scope);
}

function rememberStateScope(scope: IAgentAssistantChatScope | null) {
    lastStateScope = scope ? cloneAssistantScope(scope) : null;
}

function getChatSession(scope: IAgentAssistantChatScope, options: { create: true }): IAssistantChatSession;
function getChatSession(scope: IAgentAssistantChatScope | null, options?: { create?: false }): IAssistantChatSession | null;
function getChatSession(
    scope: IAgentAssistantChatScope | null,
    options: { create?: boolean } = {},
) {
    if (!scope) {
        return null;
    }

    const normalizedScope = normalizeAssistantScope(scope);
    if (!normalizedScope) {
        return null;
    }

    const existing = chatSessions.get(normalizedScope.key);
    if (existing) {
        existing.scope = normalizedScope;
        return existing;
    }

    if (!options.create) {
        return null;
    }

    const session: IAssistantChatSession = {
        scope: normalizedScope,
        threadId: null,
        activeTurnId: null,
        turnPhase: 'idle',
        messages: [],
    };
    chatSessions.set(normalizedScope.key, session);
    return session;
}

function getActiveChatSession() {
    return activeChatKey ? chatSessions.get(activeChatKey) ?? null : null;
}

function getChatSessionByThreadId(candidateThreadId: string | null) {
    if (!candidateThreadId) {
        return null;
    }

    return Array.from(chatSessions.values())
        .find(session => session.threadId === candidateThreadId) ?? null;
}

function getRequestChatSession(request?: IAgentAssistantStateRequest | IAgentAssistantScopedRequest | null) {
    const scope = resolveRequestedScope(request);
    rememberStateScope(scope);
    return scope ? getChatSession(scope, { create: true }) : null;
}

function tomlString(value: string) {
    return JSON.stringify(value);
}

function createAssistantCodexConfig(serverUrl: string) {
    const enabledTools = ASSISTANT_MCP_TOOLS.map(tomlString).join(', ');
    return [
        'cli_auth_credentials_store = "file"',
        'model_reasoning_effort = "low"',
        'web_search = "disabled"',
        'sandbox_mode = "read-only"',
        'approval_policy = "never"',
        'default_permissions = "evb-mcp-only"',
        '',
        '[features]',
        'shell_tool = false',
        'unified_exec = false',
        'shell_snapshot = false',
        'multi_agent = false',
        'apps = false',
        'memories = false',
        'hooks = false',
        '',
        '[permissions.evb-mcp-only.filesystem]',
        '":minimal" = "read"',
        '',
        '[permissions.evb-mcp-only.network]',
        'enabled = false',
        '',
        `[mcp_servers.${ASSISTANT_MCP_SERVER_NAME}]`,
        `url = ${tomlString(serverUrl)}`,
        `bearer_token_env_var = ${tomlString(ASSISTANT_MCP_TOKEN_ENV)}`,
        `enabled_tools = [${enabledTools}]`,
        '',
    ].join('\n');
}

async function writeAssistantConfig(codeHome: string, serverUrl: string) {
    await mkdir(codeHome, { recursive: true });
    await writeFile(join(codeHome, 'config.toml'), createAssistantCodexConfig(serverUrl), 'utf-8');
}

function createBaseMcpStatus() {
    const descriptor = getEmbeddedMcpServerDescriptor();
    return {
        serverName: descriptor?.name ?? ASSISTANT_MCP_SERVER_NAME,
        serverUrl: descriptor?.url ?? '',
        serverRunning: isEmbeddedMcpServerRunning(),
        toolCount: 0,
    };
}

function normalizeAccount(rawAccount: unknown): IAgentAssistantAccount | null {
    if (!isRecord(rawAccount) || typeof rawAccount.type !== 'string') {
        return null;
    }
    if (rawAccount.type === 'chatgpt') {
        return {
            type: 'chatgpt',
            ...(typeof rawAccount.email === 'string' ? { email: rawAccount.email } : {}),
            ...(typeof rawAccount.planType === 'string' ? { planType: rawAccount.planType } : {}),
        };
    }
    if (rawAccount.type === 'apiKey') {
        return { type: 'apiKey' };
    }
    return { type: 'other' };
}

function currentStatus(scope: IAgentAssistantChatScope | null = lastStateScope): IAgentAssistantStatus {
    const codexInfo = codexInfoCache;
    const installed = codexInfo?.installed === true;
    const versionSupported = codexInfo?.isVersionSupported === true;
    const supported = process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux';
    const session = getChatSession(scope);
    const sessionTurnPhase = session?.turnPhase ?? turnPhase;
    const sessionActiveTurnId = session?.activeTurnId ?? activeTurnId;
    const sessionThreadId = session?.threadId ?? null;
    const error = session?.lastError ?? lastError;
    return {
        supported,
        platform: process.platform,
        installState: supported
            ? installed
                ? 'installed'
                : 'missing'
            : 'unsupported',
        codexInstalled: installed,
        codexPath: codexInfo?.path ?? null,
        codexVersion: codexInfo?.version ?? null,
        minimumCodexVersion: codexInfo?.minimumVersion ?? '0.133.0',
        codexVersionSupported: versionSupported,
        installUrl: CODEX_APP_INSTALL_URL,
        installScriptUrl: CODEX_STANDALONE_INSTALL_URL,
        managedInstallDir: codexInfo?.managedInstallDir ?? '',
        authState,
        account,
        runtimeState,
        mcp: createBaseMcpStatusWithToolCount(),
        turn: {
            id: sessionActiveTurnId,
            phase: sessionTurnPhase,
        },
        threadId: sessionThreadId,
        activeTurnId: sessionActiveTurnId,
        lastCheckedAt: new Date().toISOString(),
        ...(error ? { error } : {}),
    };
}

function cloneAssistantAttachment(attachment: IAgentAssistantImageAttachment): IAgentAssistantImageAttachment {
    return { ...attachment };
}

function cloneAssistantMessage(message: IAgentAssistantChatMessage): IAgentAssistantChatMessage {
    return {
        ...message,
        ...(message.attachments === undefined
            ? {}
            : { attachments: message.attachments.map(cloneAssistantAttachment) }),
    };
}

function cloneMessages(scope: IAgentAssistantChatScope | null = lastStateScope) {
    return getChatSession(scope)?.messages.map(cloneAssistantMessage) ?? [];
}

function currentState(scope: IAgentAssistantChatScope | null = lastStateScope): IAgentAssistantState {
    return {
        scope: scope ? cloneAssistantScope(scope) : null,
        status: currentStatus(scope),
        messages: cloneMessages(scope),
    };
}

function publishAssistantEvent(
    event: IAgentAssistantEvent,
    scope: IAgentAssistantChatScope | null = lastStateScope,
) {
    const payload: IAgentAssistantEvent = {
        ...event,
        state: event.state ?? currentState(scope),
    };
    for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) {
            continue;
        }
        window.webContents.send(CORE_IPC_EVENT_CHANNELS.agentAssistantEvent, payload);
    }
}

function publishState(scope: IAgentAssistantChatScope | null = lastStateScope) {
    publishAssistantEvent({
        type: 'state',
        state: currentState(scope),
    }, scope);
}

function addMessage(
    session: IAssistantChatSession,
    message: Omit<IAgentAssistantChatMessage, 'id' | 'createdAt'> & { id?: string },
) {
    const nextMessage: IAgentAssistantChatMessage = {
        id: message.id ?? randomUUID(),
        role: message.role,
        text: message.text,
        createdAt: new Date().toISOString(),
        ...(message.attachments === undefined
            ? {}
            : { attachments: message.attachments.map(cloneAssistantAttachment) }),
        ...(message.pending === undefined ? {} : { pending: message.pending }),
        ...(message.error === undefined ? {} : { error: message.error }),
    };
    session.messages.push(nextMessage);
    publishAssistantEvent({
        type: 'message',
        message: nextMessage,
    }, session.scope);
    return nextMessage;
}

function upsertAssistantMessage(
    session: IAssistantChatSession,
    id: string,
    patch: Partial<IAgentAssistantChatMessage>,
) {
    const existing = session.messages.find(message => message.id === id);
    if (existing) {
        Object.assign(existing, patch);
        publishAssistantEvent({
            type: 'message',
            message: cloneAssistantMessage(existing),
        }, session.scope);
        return existing;
    }

    return addMessage(session, {
        id,
        role: 'assistant',
        text: patch.text ?? '',
        ...(patch.attachments === undefined ? {} : { attachments: patch.attachments }),
        ...(patch.pending === undefined ? {} : { pending: patch.pending }),
        ...(patch.error === undefined ? {} : { error: patch.error }),
    });
}

function appendAssistantDelta(session: IAssistantChatSession, messageId: string, delta: string) {
    const message = upsertAssistantMessage(session, messageId, { pending: true });
    message.text += delta;
    publishAssistantEvent({
        type: 'message-delta',
        messageId,
        delta,
    }, session.scope);
}

function getStringParam(params: unknown, key: string) {
    return isRecord(params) && typeof params[key] === 'string'
        ? params[key]
        : null;
}

function getThreadItem(params: unknown) {
    return isRecord(params) && isRecord(params.item) ? params.item : null;
}

function getNotificationThreadId(params: unknown) {
    if (!isRecord(params)) {
        return null;
    }
    if (typeof params.threadId === 'string') {
        return params.threadId;
    }
    if (isRecord(params.thread) && typeof params.thread.id === 'string') {
        return params.thread.id;
    }
    return null;
}

function shouldIgnoreThreadNotification(method: string, params: unknown) {
    const notificationThreadId = getNotificationThreadId(params);
    if (!notificationThreadId || method === 'thread/started') {
        return false;
    }
    return !getChatSessionByThreadId(notificationThreadId);
}

function getNotificationChatSession(params: unknown) {
    return getChatSessionByThreadId(getNotificationThreadId(params)) ?? getActiveChatSession();
}

function handleAppServerNotification(notification: IJsonRpcNotification) {
    const method = typeof notification.method === 'string' ? notification.method : '';
    const params = notification.params;
    if (shouldIgnoreThreadNotification(method, params)) {
        logger.info(`Ignoring stale assistant notification for inactive thread: ${method}`);
        return;
    }

    if (method === 'account/login/completed') {
        const success = isRecord(params) && params.success === true;
        const error = isRecord(params) && typeof params.error === 'string' ? params.error : null;
        if (success) {
            focusAssistantReturnWindow();
        } else {
            authReturnWindow = null;
        }
        pendingLoginId = null;
        authState = success ? 'signed-in' : 'signed-out';
        lastError = success ? undefined : error ?? 'ChatGPT sign-in failed.';
        void refreshAuthStateAndRuntimeAvailability({ recoverFromError: success }).finally(publishState);
        return;
    }

    if (method === 'account/updated') {
        void refreshAuthStateAndRuntimeAvailability().finally(publishState);
        return;
    }

    if (method === 'turn/started') {
        const session = getNotificationChatSession(params);
        if (!session) {
            return;
        }
        session.activeTurnId = isRecord(params) && isRecord(params.turn) && typeof params.turn.id === 'string'
            ? params.turn.id
            : session.activeTurnId;
        activeChatKey = session.scope.key;
        activeTurnId = session.activeTurnId;
        runtimeState = 'busy';
        turnPhase = 'running';
        session.turnPhase = 'running';
        publishAssistantEvent({
            type: 'turn-started',
            ...(activeTurnId ? { turnId: activeTurnId } : {}),
        }, session.scope);
        return;
    }

    if (method === 'turn/completed') {
        const session = getNotificationChatSession(params);
        if (!session) {
            return;
        }
        session.activeTurnId = null;
        session.turnPhase = 'idle';
        activeTurnId = null;
        runtimeState = 'ready';
        turnPhase = 'idle';
        for (const message of session.messages) {
            if (message.role === 'assistant' && message.pending) {
                message.pending = false;
            }
        }
        publishAssistantEvent({ type: 'turn-completed' }, session.scope);
        return;
    }

    if (method === 'item/agentMessage/delta') {
        const session = getNotificationChatSession(params);
        if (!session) {
            return;
        }
        const itemId = getStringParam(params, 'itemId');
        const delta = getStringParam(params, 'delta');
        if (runtimeState === 'busy') {
            turnPhase = 'running';
            session.turnPhase = 'running';
        }
        if (itemId && delta) {
            appendAssistantDelta(session, itemId, delta);
        }
        return;
    }

    if (method === 'item/completed') {
        const session = getNotificationChatSession(params);
        if (!session) {
            return;
        }
        const item = getThreadItem(params);
        if (item?.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string') {
            upsertAssistantMessage(session, item.id, {
                text: item.text,
                pending: runtimeState === 'busy',
            });
        }
        return;
    }

    if (method === 'error') {
        const session = getNotificationChatSession(params);
        lastError = isRecord(params) && isRecord(params.error) && typeof params.error.message === 'string'
            ? params.error.message
            : 'Codex assistant turn failed.';
        if (session) {
            session.lastError = lastError;
            session.activeTurnId = null;
            session.turnPhase = 'error';
        }
        runtimeState = 'error';
        turnPhase = 'error';
        activeTurnId = null;
        if (session) {
            addMessage(session, {
                role: 'system',
                text: lastError,
                error: lastError,
            });
        }
        publishAssistantEvent({
            type: 'error',
            error: lastError,
        }, session?.scope ?? lastStateScope);
    }
}

function handleAppServerExit(message: string) {
    const session = getActiveChatSession();
    runtime = null;
    runtimeState = 'error';
    turnPhase = 'error';
    activeTurnId = null;
    if (session) {
        session.activeTurnId = null;
        session.turnPhase = 'error';
        session.lastError = message;
    }
    lastError = message;
    publishAssistantEvent({
        type: 'error',
        error: message,
    }, session?.scope ?? lastStateScope);
}

async function refreshCodexInfo() {
    codexInfoCache = await getCodexCliInfo();
    return codexInfoCache;
}

async function refreshAuthState() {
    if (!runtime) {
        authState = 'unknown';
        account = null;
        return;
    }

    try {
        const accountResponse = await runtime.client.request('account/read', { refreshToken: true });
        const normalizedAccount = normalizeAccount(isRecord(accountResponse) ? accountResponse.account : null);
        if (normalizedAccount) {
            authState = 'signed-in';
            account = normalizedAccount;
            return;
        }

        const accountRequiresOpenaiAuth = isRecord(accountResponse) && accountResponse.requiresOpenaiAuth === true;
        if (accountRequiresOpenaiAuth) {
            authState = 'signed-out';
            account = null;
            return;
        }

        const authStatus = await runtime.client.request('getAuthStatus', {
            includeToken: false,
            refreshToken: true,
        });
        const statusRequiresOpenaiAuth = isRecord(authStatus) && authStatus.requiresOpenaiAuth === true;
        const hasAuthMethod = isRecord(authStatus) && authStatus.authMethod != null;
        authState = statusRequiresOpenaiAuth || !hasAuthMethod
            ? 'signed-out'
            : 'signed-in';
        account = null;
    } catch (error) {
        logger.warn(`Failed to read Codex auth state: ${getErrorMessage(error)}`);
        authState = 'unknown';
        account = null;
    }
}

function syncRuntimeStateAfterAuthCheck(options: { recoverFromError?: boolean } = {}) {
    if (!runtime || runtimeState === 'busy') {
        return;
    }
    if (runtimeState === 'error' && !options.recoverFromError) {
        return;
    }

    runtimeState = authState === 'signed-in' ? 'ready' : 'stopped';
    turnPhase = 'idle';
}

async function refreshAuthStateAndRuntimeAvailability(options: { recoverFromError?: boolean } = {}) {
    await refreshAuthState();
    syncRuntimeStateAfterAuthCheck(options);
}

async function ensureAssistantRuntime() {
    if (!(await isAssistantFeatureEnabled())) {
        await shutdownAgentAssistant();
        throw new Error(createAssistantDisabledError());
    }

    if (runtime) {
        return runtime;
    }

    runtimeState = 'starting';
    turnPhase = 'idle';
    lastError = undefined;
    publishState();

    const codexInfo = await refreshCodexInfo();
    if (!codexInfo.installed || !codexInfo.path) {
        runtimeState = 'stopped';
        turnPhase = 'idle';
        authState = 'unknown';
        publishState();
        throw new Error('Codex is not installed.');
    }
    if (!codexInfo.isVersionSupported) {
        runtimeState = 'error';
        turnPhase = 'error';
        lastError = `Codex ${codexInfo.version ?? ''} is too old. EVB Assistant requires Codex ${codexInfo.minimumVersion} or newer.`;
        publishState();
        throw new Error(lastError);
    }

    const codeHome = getAssistantCodexHome();
    const cwd = getAssistantCwd();
    await mkdir(cwd, { recursive: true });
    const mcpToken = createMcpToken();
    await shutdownEmbeddedMcpServer();
    const descriptor = await startEmbeddedMcpServer(mcpToken);
    await writeAssistantConfig(codeHome, descriptor.url);

    const client = new CodexAppServerClient(
        codexInfo.path,
        {
            ...process.env,
            CODEX_HOME: codeHome,
            [ASSISTANT_MCP_TOKEN_ENV]: mcpToken,
            NO_COLOR: '1',
        },
        cwd,
        handleAppServerNotification,
        handleAppServerExit,
    );
    const nextRuntime: IAssistantRuntime = {
        client,
        codexPath: codexInfo.path,
        codeHome,
        cwd,
        mcpToken,
    };
    runtime = nextRuntime;

    try {
        await client.initialize();
        await refreshAuthState();
        syncRuntimeStateAfterAuthCheck();
        await refreshMcpToolCount();
        publishState();
        return nextRuntime;
    } catch (error) {
        client.shutdown();
        runtime = null;
        runtimeState = 'error';
        turnPhase = 'error';
        lastError = getErrorMessage(error);
        await shutdownEmbeddedMcpServer();
        publishState();
        throw error;
    }
}

async function refreshMcpToolCount() {
    if (!runtime) {
        return;
    }

    try {
        const response = await runtime.client.request('mcpServerStatus/list', {detail: 'toolsAndAuthOnly'});
        if (!isRecord(response) || !Array.isArray(response.data)) {
            return;
        }
        const server = response.data.find(candidate => isRecord(candidate) && candidate.name === ASSISTANT_MCP_SERVER_NAME);
        if (!isRecord(server) || !isRecord(server.tools)) {
            return;
        }
        const descriptor = getEmbeddedMcpServerDescriptor();
        if (!descriptor) {
            return;
        }
        // Store the count on the next state snapshot through a lightweight cache.
        mcpToolCount = Object.keys(server.tools).length;
    } catch (error) {
        logger.warn(`Failed to read embedded MCP status: ${getErrorMessage(error)}`);
    }
}

let mcpToolCount = 0;

function createBaseMcpStatusWithToolCount() {
    const base = createBaseMcpStatus();
    return {
        ...base,
        toolCount: mcpToolCount,
    };
}

async function ensureAssistantThread(session: IAssistantChatSession) {
    const currentRuntime = await ensureAssistantRuntime();
    if (authState !== 'signed-in') {
        throw new Error('Sign in with ChatGPT before using EVB Assistant.');
    }
    if (session.threadId) {
        return session.threadId;
    }

    const response = await currentRuntime.client.request('thread/start', {
        cwd: currentRuntime.cwd,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        serviceName: 'EVB Assistant',
        developerInstructions: ASSISTANT_ROLE_PROMPT,
        personality: 'friendly',
        ephemeral: true,
        threadSource: 'user',
    });
    if (!isRecord(response) || !isRecord(response.thread) || typeof response.thread.id !== 'string') {
        throw new Error('Codex did not return an assistant thread.');
    }
    session.threadId = response.thread.id;
    session.activeTurnId = null;
    session.turnPhase = 'idle';
    activeChatKey = session.scope.key;
    runtimeState = 'ready';
    turnPhase = 'idle';
    publishState(session.scope);
    return session.threadId;
}

function estimateBase64ByteSize(base64: string) {
    const padding = base64.endsWith('==')
        ? 2
        : base64.endsWith('=')
            ? 1
            : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
}

function parseAssistantImageDataUrl(dataUrl: string): {
    base64: string;
    mimeType: string;
    sizeBytes: number;
} | null {
    const match = /^data:([^,]+),([a-z0-9+/=\r\n ]+)$/iu.exec(dataUrl.trim());
    if (!match) {
        return null;
    }

    const headerParts = match[1]!.split(';').map(part => part.trim().toLowerCase()).filter(Boolean);
    const mimeType = headerParts[0] ?? '';
    if (!mimeType.startsWith('image/') || !headerParts.includes('base64')) {
        return null;
    }

    const base64 = match[2]!.replace(/\s+/gu, '');
    if (!base64 || !/^[a-z0-9+/]+={0,2}$/iu.test(base64)) {
        return null;
    }

    const sizeBytes = estimateBase64ByteSize(base64);
    if (sizeBytes <= 0 || sizeBytes > ASSISTANT_MAX_IMAGE_BYTES) {
        return null;
    }

    return {
        base64,
        mimeType,
        sizeBytes,
    };
}

function normalizeAttachmentName(name: string, index: number) {
    return name.trim().slice(0, 160) || `image-${index + 1}`;
}

function normalizeOutgoingAttachments(request: IAgentAssistantSendMessageRequest) {
    const rawAttachments = Array.isArray(request.attachments) ? request.attachments : [];
    if (rawAttachments.length > ASSISTANT_MAX_IMAGE_ATTACHMENTS) {
        throw new Error(`EVB Assistant accepts up to ${ASSISTANT_MAX_IMAGE_ATTACHMENTS} images per message.`);
    }

    return rawAttachments.map((attachment, index): IAgentAssistantImageAttachment => {
        const parsed = parseAssistantImageDataUrl(attachment.dataUrl);
        if (!parsed) {
            throw new Error('One attached image is invalid or too large.');
        }

        return {
            type: 'image',
            id: attachment.id.trim() || randomUUID(),
            name: normalizeAttachmentName(attachment.name, index),
            mimeType: parsed.mimeType,
            sizeBytes: parsed.sizeBytes,
            dataUrl: `data:${parsed.mimeType};base64,${parsed.base64}`,
        };
    });
}

function normalizeOutgoingMessageRequest(request: IAgentAssistantSendMessageRequest) {
    return {
        text: typeof request.text === 'string' ? request.text.trim() : '',
        attachments: normalizeOutgoingAttachments(request),
    };
}

export async function getAgentAssistantState(
    request?: IAgentAssistantStateRequest,
): Promise<IAgentAssistantState> {
    const session = getRequestChatSession(request);
    const scope = session?.scope ?? null;
    if (!(await isAssistantFeatureEnabled())) {
        await shutdownAgentAssistant();
        return currentState(scope);
    }

    await refreshCodexInfo();
    if (codexInfoCache?.installed && codexInfoCache.isVersionSupported) {
        try {
            await ensureAssistantRuntime();
            await refreshAuthStateAndRuntimeAvailability();
        } catch (error) {
            logger.warn(`Assistant runtime is not ready: ${getErrorMessage(error)}`);
        }
    }
    return currentState(scope);
}

export async function installAgentAssistantCodex(): Promise<IAgentAssistantInstallResult> {
    if (!(await isAssistantFeatureEnabled())) {
        const error = await stopAssistantForDisabledFeature();
        return {
            ok: false,
            state: currentState(),
            error,
        };
    }

    if (installPromise) {
        return installPromise;
    }

    installPromise = (async () => {
        try {
            lastError = undefined;
            publishAssistantEvent({
                type: 'install-progress',
                progress: 'Starting Codex installation.',
            });
            codexInfoCache = await installManagedCodex({onProgress: (progress) => publishAssistantEvent({
                type: 'install-progress',
                progress,
            })});
            publishAssistantEvent({
                type: 'install-progress',
                progress: 'Codex installation complete.',
            });
            await ensureAssistantRuntime();
            return {
                ok: true,
                state: currentState(),
            };
        } catch (error) {
            lastError = getErrorMessage(error);
            runtimeState = 'error';
            turnPhase = 'error';
            publishAssistantEvent({
                type: 'error',
                error: lastError,
            });
            return {
                ok: false,
                state: currentState(),
                error: lastError,
            };
        } finally {
            installPromise = null;
        }
    })();
    return installPromise;
}

export async function startAgentAssistantLogin(
    request: IAgentAssistantLoginRequest,
    parentWindow?: BrowserWindow | null,
): Promise<IAgentAssistantLoginResult> {
    try {
        const currentRuntime = await ensureAssistantRuntime();
        const params = request.mode === 'device-code'
            ? { type: 'chatgptDeviceCode' }
            : {
                type: 'chatgpt',
                codexStreamlinedLogin: true,
            };
        const response = await currentRuntime.client.request('account/login/start', params);
        if (!isRecord(response) || typeof response.type !== 'string') {
            throw new Error('Codex did not return a login flow.');
        }

        pendingLoginId = typeof response.loginId === 'string' ? response.loginId : null;
        authState = 'login-pending';
        rememberAssistantReturnWindow(parentWindow);
        const authUrl = typeof response.authUrl === 'string' ? response.authUrl : undefined;
        const verificationUrl = typeof response.verificationUrl === 'string' ? response.verificationUrl : undefined;
        const urlToOpen = authUrl ?? verificationUrl;
        if (urlToOpen) {
            await shell.openExternal(urlToOpen);
        }
        publishState();
        return {
            ok: true,
            state: currentState(),
            ...(pendingLoginId ? { loginId: pendingLoginId } : {}),
            ...(authUrl ? { authUrl } : {}),
            ...(verificationUrl ? { verificationUrl } : {}),
            ...(typeof response.userCode === 'string' ? { userCode: response.userCode } : {}),
        };
    } catch (error) {
        authReturnWindow = null;
        lastError = getErrorMessage(error);
        authState = 'signed-out';
        publishAssistantEvent({
            type: 'error',
            error: lastError,
        });
        return {
            ok: false,
            state: currentState(),
            error: lastError,
        };
    }
}

export async function cancelAgentAssistantLogin(): Promise<IAgentAssistantState> {
    authReturnWindow = null;
    if (runtime && pendingLoginId) {
        await runtime.client.request('account/login/cancel', { loginId: pendingLoginId }).catch((error: unknown) => {
            logger.warn(`Failed to cancel assistant login: ${getErrorMessage(error)}`);
        });
    }
    pendingLoginId = null;
    await refreshAuthState();
    publishState();
    return currentState();
}

export async function sendAgentAssistantMessage(
    request: IAgentAssistantSendMessageRequest,
): Promise<IAgentAssistantSendMessageResult> {
    if (!(await isAssistantFeatureEnabled())) {
        const error = await stopAssistantForDisabledFeature();
        return {
            ok: false,
            state: currentState(),
            error,
        };
    }

    const scope = normalizeAssistantScope(request.scope);
    rememberStateScope(scope);
    if (!scope) {
        const error = 'Open a document before starting an EVB Assistant chat.';
        lastError = error;
        return {
            ok: false,
            state: currentState(null),
            error,
        };
    }
    const session = getChatSession(scope, { create: true });

    let normalizedRequest: ReturnType<typeof normalizeOutgoingMessageRequest>;
    try {
        normalizedRequest = normalizeOutgoingMessageRequest(request);
    } catch (error) {
        lastError = getErrorMessage(error);
        session.lastError = lastError;
        return {
            ok: false,
            state: currentState(session.scope),
            error: lastError,
        };
    }

    const {
        text,
        attachments,
    } = normalizedRequest;
    if (!text && attachments.length === 0) {
        return {
            ok: false,
            state: currentState(session.scope),
            error: 'Message is empty.',
        };
    }

    let currentThreadId: string | null = null;
    try {
        const currentRuntime = await ensureAssistantRuntime();
        currentThreadId = await ensureAssistantThread(session);
        activeChatKey = session.scope.key;
        runtimeState = 'busy';
        turnPhase = 'starting';
        activeTurnId = null;
        session.activeTurnId = null;
        session.turnPhase = 'starting';
        delete session.lastError;
        addMessage(session, {
            role: 'user',
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
        });
        publishState(session.scope);
        const response = await currentRuntime.client.request('turn/start', {
            threadId: currentThreadId,
            input: [
                {
                    type: 'text',
                    text: text || ASSISTANT_IMAGE_ONLY_PROMPT,
                    text_elements: [],
                },
                ...attachments.map(attachment => ({
                    type: 'image',
                    url: attachment.dataUrl,
                })),
            ],
            cwd: currentRuntime.cwd,
            approvalPolicy: 'never',
            sandboxPolicy: {
                type: 'readOnly',
                networkAccess: false,
            },
            personality: 'friendly',
        });
        if (isRecord(response) && isRecord(response.turn) && typeof response.turn.id === 'string') {
            if (session.threadId !== currentThreadId) {
                return {
                    ok: true,
                    state: currentState(session.scope),
                };
            }
            activeTurnId = response.turn.id;
            session.activeTurnId = response.turn.id;
            turnPhase = 'running';
            session.turnPhase = 'running';
        }
        publishState(session.scope);
        return {
            ok: true,
            state: currentState(session.scope),
        };
    } catch (error) {
        if (currentThreadId && session.threadId !== currentThreadId) {
            return {
                ok: false,
                state: currentState(session.scope),
                error: getErrorMessage(error),
            };
        }
        lastError = getErrorMessage(error);
        session.lastError = lastError;
        runtimeState = 'error';
        turnPhase = 'error';
        session.activeTurnId = null;
        session.turnPhase = 'error';
        addMessage(session, {
            role: 'system',
            text: lastError,
            error: lastError,
        });
        return {
            ok: false,
            state: currentState(session.scope),
            error: lastError,
        };
    }
}

export async function interruptAgentAssistant(
    request?: IAgentAssistantScopedRequest,
): Promise<IAgentAssistantState> {
    const requestedSession = getRequestChatSession(request);
    const session = requestedSession ?? getActiveChatSession();
    if (runtime && session?.threadId && session.activeTurnId) {
        turnPhase = 'interrupting';
        session.turnPhase = 'interrupting';
        publishState(session.scope);
        await runtime.client.request('turn/interrupt', {
            threadId: session.threadId,
            turnId: session.activeTurnId,
        }).catch((error: unknown) => {
            logger.warn(`Failed to interrupt assistant turn: ${getErrorMessage(error)}`);
        });
    }
    if (session) {
        session.activeTurnId = null;
        session.turnPhase = 'idle';
    }
    activeTurnId = null;
    runtimeState = authState === 'signed-in' ? 'ready' : 'stopped';
    turnPhase = 'idle';
    publishState(session?.scope ?? null);
    return currentState(session?.scope ?? null);
}

export async function resetAgentAssistantChat(
    request?: IAgentAssistantScopedRequest,
): Promise<IAgentAssistantState> {
    const session = getRequestChatSession(request);
    if (!session) {
        return currentState(null);
    }

    const previousThreadId = session.threadId;
    const previousTurnId = session.activeTurnId;
    if (runtime && previousThreadId && previousTurnId) {
        turnPhase = 'interrupting';
        session.turnPhase = 'interrupting';
        publishState(session.scope);
        await runtime.client.request('turn/interrupt', {
            threadId: previousThreadId,
            turnId: previousTurnId,
        }).catch((error: unknown) => {
            logger.warn(`Failed to interrupt assistant turn during reset: ${getErrorMessage(error)}`);
        });
    }

    if (runtime && previousThreadId) {
        void runtime.client.request('thread/archive', { threadId: previousThreadId }).catch((error: unknown) => {
            logger.warn(`Failed to archive reset assistant thread: ${getErrorMessage(error)}`);
        });
    }

    session.threadId = null;
    session.activeTurnId = null;
    session.turnPhase = 'idle';
    session.messages.length = 0;
    delete session.lastError;
    if (activeChatKey === session.scope.key) {
        activeChatKey = null;
    }
    activeTurnId = null;
    lastError = undefined;
    turnPhase = 'idle';
    runtimeState = authState === 'signed-in' ? 'ready' : 'stopped';
    publishState(session.scope);
    return currentState(session.scope);
}

export async function shutdownAgentAssistant() {
    authReturnWindow = null;
    pendingLoginId = null;
    runtime?.client.shutdown();
    runtime = null;
    runtimeState = 'stopped';
    turnPhase = 'idle';
    activeTurnId = null;
    activeChatKey = null;
    for (const session of chatSessions.values()) {
        session.threadId = null;
        session.activeTurnId = null;
        session.turnPhase = 'idle';
    }
    mcpToolCount = 0;
    await shutdownEmbeddedMcpServer();
}
