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
    IAgentAssistantChatMessage,
    IAgentAssistantEvent,
    IAgentAssistantImageAttachment,
    IAgentAssistantInstallResult,
    IAgentAssistantLoginRequest,
    IAgentAssistantLoginResult,
    IAgentAssistantSendMessageRequest,
    IAgentAssistantSendMessageResult,
    IAgentAssistantState,
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
    'You are EVB Assistant, an assistant embedded inside EVB Viewer for scientists and researchers.',
    'You can help with the current EVB Viewer workspace and, when a document is open, with that document by using the EVB Viewer MCP tools.',
    'A document may not be open. Do not assume there is a current document; inspect the workspace when document state matters, and help the user open or prepare a document when the workspace is empty.',
    'Use the compact capability workflow for EVB work: inspect with evb_workspace_snapshot, discover actions with evb_list_capabilities, inspect schemas with evb_describe_capability, read EVB resources with evb_read_resource, and run visible app actions with evb_run_action.',
    'For searching or reading a PDF, use capabilities such as document.search and document.read_pages through evb_run_action; for notes, annotations, bookmarks, and page labels, read evb://document/{tabId}/notes, /annotations, /bookmarks, /toc, or /page-labels through evb_read_resource. To create annotation content directly, use annotation.create_text_markup, annotation.create_note_at_point, and annotation.create_shape instead of only selecting the annotation toolbar. Use annotation.update_note and annotation.update_text_markup_color for existing annotations. For document metadata, use page_labels.set_ranges/apply_range/set_labels and bookmarks.set_tree/add/add_batch/update/delete for individual or batch edits. Use document.capture_page_image for visual checks when OCR, TOC, page-label, or search evidence is ambiguous.',
    'When numbering pages from printed paper-page numbers such as iv, A, A-1, or 1, treat OCR/searchable text as the starting hypothesis. Verify range boundaries, numbering restarts, appendices, front matter, and suspicious OCR hits by reading nearby pages and capturing page images or crops before writing page labels.',
    'When creating or repairing bookmarks, treat the existing PDF TOC/bookmarks as the starting hypothesis. Verify each title and destination against searchable text and, where there is doubt, page screenshots before mutating the bookmark tree.',
    'For page-label and bookmark workflows, perform mutations only through EVB Viewer capabilities so they enter the app undo stack. After all writes are verified, save the file with file.save and report if saving fails.',
    'For OCR, use ocr.status to inspect current OCR UI state, ocr.open_popup to show OCR controls, and ocr.start only when the user explicitly asks to run OCR or has approved the capability policy.',
    'Before write, destructive, or long-running actions, inspect capability policy and use dryRun when the user intent is not already explicit.',
    'Recent files in workspace snapshots are list metadata only. Do not summarize or compare their contents unless the user opens them and EVB tools can read them.',
    'This session is sandboxed for EVB Viewer: use only the EVB Viewer MCP tools exposed in this session. Do not use local files, shell commands, browser automation, or external services.',
    'When a PDF has missing searchable text, explain that OCR or conversion is needed instead of guessing from unavailable page content.',
    'Be concise, cite page numbers when the tools provide them, and navigate the viewer only when it directly helps the user.',
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
let threadId: string | null = null;
let activeTurnId: string | null = null;
let pendingLoginId: string | null = null;
let authReturnWindow: BrowserWindow | null = null;
let lastError: string | undefined;
let installPromise: Promise<IAgentAssistantInstallResult> | null = null;
const messages: IAgentAssistantChatMessage[] = [];

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

function tomlString(value: string) {
    return JSON.stringify(value);
}

function createAssistantCodexConfig(serverUrl: string) {
    const enabledTools = ASSISTANT_MCP_TOOLS.map(tomlString).join(', ');
    return [
        'cli_auth_credentials_store = "file"',
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

function currentStatus(): IAgentAssistantStatus {
    const codexInfo = codexInfoCache;
    const installed = codexInfo?.installed === true;
    const versionSupported = codexInfo?.isVersionSupported === true;
    const supported = process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux';
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
            id: activeTurnId,
            phase: turnPhase,
        },
        threadId,
        activeTurnId,
        lastCheckedAt: new Date().toISOString(),
        ...(lastError ? { error: lastError } : {}),
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

function cloneMessages() {
    return messages.map(cloneAssistantMessage);
}

function currentState(): IAgentAssistantState {
    return {
        status: currentStatus(),
        messages: cloneMessages(),
    };
}

function publishAssistantEvent(event: IAgentAssistantEvent) {
    const payload: IAgentAssistantEvent = {
        ...event,
        state: event.state ?? currentState(),
    };
    for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) {
            continue;
        }
        window.webContents.send(CORE_IPC_EVENT_CHANNELS.agentAssistantEvent, payload);
    }
}

function publishState() {
    publishAssistantEvent({
        type: 'state',
        state: currentState(),
    });
}

function addMessage(message: Omit<IAgentAssistantChatMessage, 'id' | 'createdAt'> & { id?: string }) {
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
    messages.push(nextMessage);
    publishAssistantEvent({
        type: 'message',
        message: nextMessage,
    });
    return nextMessage;
}

function upsertAssistantMessage(id: string, patch: Partial<IAgentAssistantChatMessage>) {
    const existing = messages.find(message => message.id === id);
    if (existing) {
        Object.assign(existing, patch);
        publishAssistantEvent({
            type: 'message',
            message: cloneAssistantMessage(existing),
        });
        return existing;
    }

    return addMessage({
        id,
        role: 'assistant',
        text: patch.text ?? '',
        ...(patch.attachments === undefined ? {} : { attachments: patch.attachments }),
        ...(patch.pending === undefined ? {} : { pending: patch.pending }),
        ...(patch.error === undefined ? {} : { error: patch.error }),
    });
}

function appendAssistantDelta(messageId: string, delta: string) {
    const message = upsertAssistantMessage(messageId, { pending: true });
    message.text += delta;
    publishAssistantEvent({
        type: 'message-delta',
        messageId,
        delta,
    });
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
    return !threadId || notificationThreadId !== threadId;
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
        activeTurnId = isRecord(params) && isRecord(params.turn) && typeof params.turn.id === 'string'
            ? params.turn.id
            : activeTurnId;
        runtimeState = 'busy';
        turnPhase = 'running';
        publishAssistantEvent({
            type: 'turn-started',
            ...(activeTurnId ? { turnId: activeTurnId } : {}),
        });
        return;
    }

    if (method === 'turn/completed') {
        activeTurnId = null;
        runtimeState = 'ready';
        turnPhase = 'idle';
        for (const message of messages) {
            if (message.role === 'assistant' && message.pending) {
                message.pending = false;
            }
        }
        publishAssistantEvent({ type: 'turn-completed' });
        return;
    }

    if (method === 'item/agentMessage/delta') {
        const itemId = getStringParam(params, 'itemId');
        const delta = getStringParam(params, 'delta');
        if (runtimeState === 'busy') {
            turnPhase = 'running';
        }
        if (itemId && delta) {
            appendAssistantDelta(itemId, delta);
        }
        return;
    }

    if (method === 'item/completed') {
        const item = getThreadItem(params);
        if (item?.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string') {
            upsertAssistantMessage(item.id, {
                text: item.text,
                pending: runtimeState === 'busy',
            });
        }
        return;
    }

    if (method === 'error') {
        lastError = isRecord(params) && isRecord(params.error) && typeof params.error.message === 'string'
            ? params.error.message
            : 'Codex assistant turn failed.';
        runtimeState = 'error';
        turnPhase = 'error';
        activeTurnId = null;
        addMessage({
            role: 'system',
            text: lastError,
            error: lastError,
        });
        publishAssistantEvent({
            type: 'error',
            error: lastError,
        });
    }
}

function handleAppServerExit(message: string) {
    runtime = null;
    runtimeState = 'error';
    turnPhase = 'error';
    activeTurnId = null;
    lastError = message;
    publishAssistantEvent({
        type: 'error',
        error: message,
    });
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

async function ensureAssistantThread() {
    const currentRuntime = await ensureAssistantRuntime();
    if (authState !== 'signed-in') {
        throw new Error('Sign in with ChatGPT before using EVB Assistant.');
    }
    if (threadId) {
        return threadId;
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
    threadId = response.thread.id;
    runtimeState = 'ready';
    turnPhase = 'idle';
    publishState();
    return threadId;
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

export async function getAgentAssistantState(): Promise<IAgentAssistantState> {
    if (!(await isAssistantFeatureEnabled())) {
        await shutdownAgentAssistant();
        return currentState();
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
    return currentState();
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

    let normalizedRequest: ReturnType<typeof normalizeOutgoingMessageRequest>;
    try {
        normalizedRequest = normalizeOutgoingMessageRequest(request);
    } catch (error) {
        lastError = getErrorMessage(error);
        return {
            ok: false,
            state: currentState(),
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
            state: currentState(),
            error: 'Message is empty.',
        };
    }

    let currentThreadId: string | null = null;
    try {
        const currentRuntime = await ensureAssistantRuntime();
        currentThreadId = await ensureAssistantThread();
        runtimeState = 'busy';
        turnPhase = 'starting';
        addMessage({
            role: 'user',
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
        });
        publishState();
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
            if (threadId !== currentThreadId) {
                return {
                    ok: true,
                    state: currentState(),
                };
            }
            activeTurnId = response.turn.id;
            turnPhase = 'running';
        }
        publishState();
        return {
            ok: true,
            state: currentState(),
        };
    } catch (error) {
        if (currentThreadId && threadId !== currentThreadId) {
            return {
                ok: false,
                state: currentState(),
                error: getErrorMessage(error),
            };
        }
        lastError = getErrorMessage(error);
        runtimeState = 'error';
        turnPhase = 'error';
        addMessage({
            role: 'system',
            text: lastError,
            error: lastError,
        });
        return {
            ok: false,
            state: currentState(),
            error: lastError,
        };
    }
}

export async function interruptAgentAssistant(): Promise<IAgentAssistantState> {
    if (runtime && threadId && activeTurnId) {
        turnPhase = 'interrupting';
        publishState();
        await runtime.client.request('turn/interrupt', {
            threadId,
            turnId: activeTurnId,
        }).catch((error: unknown) => {
            logger.warn(`Failed to interrupt assistant turn: ${getErrorMessage(error)}`);
        });
    }
    activeTurnId = null;
    runtimeState = authState === 'signed-in' ? 'ready' : 'stopped';
    turnPhase = 'idle';
    publishState();
    return currentState();
}

export async function resetAgentAssistantChat(): Promise<IAgentAssistantState> {
    const previousThreadId = threadId;
    const previousTurnId = activeTurnId;
    if (runtime && previousThreadId && previousTurnId) {
        turnPhase = 'interrupting';
        publishState();
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

    threadId = null;
    activeTurnId = null;
    messages.length = 0;
    lastError = undefined;
    turnPhase = 'idle';
    runtimeState = authState === 'signed-in' ? 'ready' : 'stopped';
    publishState();
    return currentState();
}

export async function shutdownAgentAssistant() {
    authReturnWindow = null;
    pendingLoginId = null;
    runtime?.client.shutdown();
    runtime = null;
    runtimeState = 'stopped';
    turnPhase = 'idle';
    activeTurnId = null;
    threadId = null;
    mcpToolCount = 0;
    await shutdownEmbeddedMcpServer();
}
