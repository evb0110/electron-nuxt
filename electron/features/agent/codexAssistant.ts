import {
    mkdir,
    writeFile,
} from 'fs/promises';
import { randomUUID } from 'crypto';
import { join } from 'path';
import {
    BrowserWindow,
    app,
    shell,
} from 'electron';
import { sanitizeAllowedExternalUrl } from '@contracts/externalUrl';
import { config } from '@electron/config';
import type {
    IAgentAssistantChatScope,
    IAgentAssistantChatMessage,
    IAgentAssistantEvent,
    IAgentAssistantImageAttachment,
    IAgentAssistantInstallResult,
    IAgentAssistantLoginRequest,
    IAgentAssistantLoginResult,
    IAgentAssistantModelOption,
    IAgentAssistantScopedRequest,
    IAgentAssistantSendMessageRequest,
    IAgentAssistantSendMessageResult,
    IAgentAssistantState,
    IAgentAssistantStateRequest,
    IAgentAssistantStatus,
    TAgentAssistantEffort,
    TAgentAssistantProviderId,
    TAgentAssistantSpeedMode,
    TAgentAssistantTurnPhase,
} from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';
import {
    ASSISTANT_DEFAULT_EFFORT,
    ASSISTANT_DEFAULT_SPEED_MODE,
    CODEX_ASSISTANT_DEFAULT_MODEL,
    CODEX_ASSISTANT_FALLBACK_MODELS,
} from '@contracts/agentModels';
import {
    CODEX_APP_INSTALL_URL,
    CODEX_STANDALONE_INSTALL_URL,
    getCodexCliInfo,
    installManagedCodex,
    type ICodexCliInfo,
} from '@electron/features/agent/codexCli';
import {
    CLAUDE_AGENT_MODELS,
    ClaudeAgentAssistantSession,
    detectClaudeAuthState,
    getClaudeAgentSdkInfo,
    isClaudeAuthErrorMessage,
    shouldUseClaudeAssistantFastMode,
    normalizeClaudeAssistantModel,
    type IClaudeAgentAssistantInit,
} from '@electron/features/agent/claudeAgentSdkAssistant';
import {
    ASSISTANT_IMAGE_ONLY_PROMPT,
    ASSISTANT_MCP_CONTRACT_VERSION,
    ASSISTANT_MCP_SERVER_NAME,
    ASSISTANT_MCP_TOKEN_ENV,
    ASSISTANT_MODEL_CONFIG_DIR,
    ASSISTANT_ROLE_PROMPT,
    createAssistantCodexConfig,
} from '@electron/features/agent/codexAssistantConfig';
import {
    CodexAppServerClient,
    type ICodexAppServerNotification,
} from '@electron/features/agent/codexAppServerClient';
import {
    normalizeCodexModelListResponse,
    type TCodexAssistantModelOption,
} from '@electron/features/agent/assistantModelCatalog';
import {
    codexDefaultModelId,
    getProviderEfforts,
    getProviderModelLabel,
    getProviderSpeedModes,
    normalizeAssistantEffort,
    normalizeAssistantModel,
    normalizeAssistantSpeedMode,
    normalizeCodexAssistantModel,
    resolveAssistantSelection,
    resolveCodexServiceTier,
    type IAssistantSelection,
    type IClaudeAssistantProviderInfo,
} from '@electron/features/agent/assistantProviderStatus';
import {
    buildAssistantProviderStatuses,
    createAssistantProviderRuntimeStates,
    getAssistantProviderRuntimeState,
} from '@electron/features/agent/assistantProviderState';
import {
    applyCodexAuthStatusResponse,
    normalizeClaudeAssistantAccount,
    normalizeCodexAssistantAccount,
} from '@electron/features/agent/assistantProviderAccounts';
import {
    createAssistantErrorEnvelope,
    withAssistantErrorEnvelope,
} from '@electron/features/agent/assistantErrorEnvelope';
import { normalizeOutgoingMessageRequest } from '@electron/features/agent/assistantOutgoingMessage';
import { resolveAssistantPresetInstructions } from '@electron/features/agent/assistantPresetWorkflows';
import {
    getEmbeddedMcpServerDescriptor,
    isEmbeddedMcpServerRunning,
    shutdownEmbeddedMcpServer,
    startEmbeddedMcpServer,
} from '@electron/features/agent/mcpServer';
import { CORE_IPC_EVENT_CHANNELS } from '@electron/platform-ipc/coreContract';
import { loadSettings } from '@electron/settings';
import { te } from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('agent-codex-assistant');

interface IAssistantRuntime {
    client: CodexAppServerClient;
    codexPath: string;
    codeHome: string;
    cwd: string;
    mcpToken: string;
    mcpServerName: string;
    mcpContractVersion: number;
    effort: TAgentAssistantEffort;
}

interface IAssistantChatSession {
    provider: TAgentAssistantProviderId;
    scope: IAgentAssistantChatScope;
    model: string;
    effort: TAgentAssistantEffort;
    speedMode: TAgentAssistantSpeedMode;
    threadId: string | null;
    activeTurnId: string | null;
    turnPhase: TAgentAssistantTurnPhase;
    messages: IAgentAssistantChatMessage[];
    lastAccessedAtMs: number;
    claudeSession: ClaudeAgentAssistantSession | undefined;
    lastError?: string;
}

let codexAssistantModels: readonly TCodexAssistantModelOption[] = CODEX_ASSISTANT_FALLBACK_MODELS;
let claudeAssistantModels: readonly IAgentAssistantModelOption[] = CLAUDE_AGENT_MODELS;
const providerRuntimeStates = createAssistantProviderRuntimeStates();
const codexProviderRuntime = getAssistantProviderRuntimeState(providerRuntimeStates, 'codex');
const claudeProviderRuntime = getAssistantProviderRuntimeState(providerRuntimeStates, 'claude');

const ASSISTANT_CHAT_SESSION_MAX_ENTRIES = (() => {
    const parsed = Number.parseInt(process.env.EVB_ASSISTANT_CHAT_SESSION_MAX_ENTRIES ?? '32', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 32;
    }
    return Math.min(parsed, 512);
})();
const ASSISTANT_CHAT_SESSION_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_ASSISTANT_CHAT_SESSION_TTL_MS ?? `${60 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 60_000) {
        return 60 * 60 * 1000;
    }
    return parsed;
})();
const CODEX_AUTH_ACCOUNT_READ_TIMEOUT_MS = 8_000;
const CODEX_AUTH_STATUS_TIMEOUT_MS = 8_000;

let codexInfoCache: ICodexCliInfo | null = null;
let runtime: IAssistantRuntime | null = null;
let runtimeStartPromise: Promise<IAssistantRuntime> | null = null;
let claudeInfoCache: IClaudeAssistantProviderInfo | null = null;
let activeChatKey: string | null = null;
let lastStateScope: IAgentAssistantChatScope | null = null;
let lastStateProvider: TAgentAssistantProviderId = 'codex';
let lastStateModel = CODEX_ASSISTANT_DEFAULT_MODEL;
let lastStateEffort: TAgentAssistantEffort = ASSISTANT_DEFAULT_EFFORT;
let lastStateSpeedMode: TAgentAssistantSpeedMode = ASSISTANT_DEFAULT_SPEED_MODE;
let pendingLoginId: string | null = null;
let authReturnWindow: BrowserWindow | null = null;
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

function ensureSharedEmbeddedMcp() {
    return startEmbeddedMcpServer();
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
    codexProviderRuntime.lastError = error;
    codexProviderRuntime.runtimeState = 'stopped';
    codexProviderRuntime.turnPhase = 'idle';
    codexProviderRuntime.activeTurnId = null;
    return error;
}

async function stopAssistantForDisabledFeature() {
    await shutdownAgentAssistant();
    return markAssistantDisabledError();
}

async function shutdownCodexAssistantRuntime(options: { shutdownMcp?: boolean } = {}) {
    authReturnWindow = null;
    pendingLoginId = null;
    runtimeStartPromise = null;
    runtime?.client.shutdown();
    runtime = null;
    codexProviderRuntime.runtimeState = 'stopped';
    codexProviderRuntime.turnPhase = 'idle';
    codexProviderRuntime.activeTurnId = null;
    if (activeChatKey && chatSessions.get(activeChatKey)?.provider === 'codex') {
        activeChatKey = null;
    }
    for (const session of chatSessions.values()) {
        if (session.provider !== 'codex') {
            continue;
        }
        session.threadId = null;
        session.activeTurnId = null;
        session.turnPhase = 'idle';
    }
    mcpToolCount = 0;
    if (options.shutdownMcp === true) {
        await shutdownEmbeddedMcpServer();
    }
}

async function shutdownClaudeAssistantRuntime(options: { shutdownMcp?: boolean } = {}) {
    const closePromises: Array<Promise<void>> = [];
    for (const session of chatSessions.values()) {
        if (session.provider !== 'claude') {
            continue;
        }
        if (session.claudeSession) {
            closePromises.push(session.claudeSession.close());
        }
        session.claudeSession = undefined;
        session.threadId = null;
        session.activeTurnId = null;
        session.turnPhase = 'idle';
    }
    await Promise.allSettled(closePromises);
    claudeProviderRuntime.runtimeState = 'stopped';
    claudeProviderRuntime.turnPhase = 'idle';
    claudeProviderRuntime.activeTurnId = null;
    claudeMcpToolCount = 0;
    if (activeChatKey && chatSessions.get(activeChatKey)?.provider === 'claude') {
        activeChatKey = null;
    }
    if (options.shutdownMcp === true) {
        await shutdownEmbeddedMcpServer();
    }
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

    const title = scope.title?.trim();
    return {
        kind: 'document',
        key,
        title: title && title.length > 0 ? title : null,
        ...(scope.tabId?.trim() ? { tabId: scope.tabId.trim() } : {}),
        ...(scope.documentRef?.trim() ? { documentRef: scope.documentRef.trim() } : {}),
    } satisfies IAgentAssistantChatScope;
}

function createChatSessionKey(provider: TAgentAssistantProviderId, scopeKey: string) {
    return `${provider}:${scopeKey}`;
}

function resolveRequestedScope(request?: IAgentAssistantStateRequest | IAgentAssistantScopedRequest | null) {
    return normalizeAssistantScope(request?.scope);
}

function rememberStateScope(
    scope: IAgentAssistantChatScope | null,
    selection: IAssistantSelection = {
        provider: lastStateProvider,
        model: lastStateModel,
        effort: lastStateEffort,
        speedMode: lastStateSpeedMode,
    },
) {
    lastStateScope = scope ? cloneAssistantScope(scope) : null;
    lastStateProvider = selection.provider;
    lastStateModel = selection.model;
    lastStateEffort = selection.effort;
    lastStateSpeedMode = selection.speedMode;
}

function touchChatSession(session: IAssistantChatSession, now = Date.now()) {
    session.lastAccessedAtMs = now;
    return session;
}

function isEvictableChatSession(session: IAssistantChatSession) {
    return session.activeTurnId === null
        && session.turnPhase !== 'starting'
        && session.turnPhase !== 'running'
        && session.turnPhase !== 'interrupting';
}

function deleteChatSession(key: string, reason: string) {
    const session = chatSessions.get(key);
    if (!session) {
        return;
    }

    chatSessions.delete(key);
    if (activeChatKey === key) {
        activeChatKey = null;
    }
    if (lastStateScope?.key === session.scope.key && lastStateProvider === session.provider) {
        lastStateScope = null;
    }

    if (session.provider === 'codex' && runtime && session.threadId) {
        void runtime.client.request('thread/archive', { threadId: session.threadId }).catch((error: unknown) => {
            logger.warn(`Failed to archive ${reason} assistant thread: ${getErrorMessage(error)}`);
        });
    }
    if (session.provider === 'claude' && session.claudeSession) {
        void session.claudeSession.close().catch((error: unknown) => {
            logger.warn(`Failed to close ${reason} Claude assistant session: ${getErrorMessage(error)}`);
        });
    }
}

function pruneChatSessions(now = Date.now()) {
    for (const [
        key,
        session,
    ] of chatSessions.entries()) {
        if (
            isEvictableChatSession(session)
            && now - session.lastAccessedAtMs > ASSISTANT_CHAT_SESSION_TTL_MS
        ) {
            deleteChatSession(key, 'expired');
        }
    }

    if (chatSessions.size <= ASSISTANT_CHAT_SESSION_MAX_ENTRIES) {
        return;
    }

    const evictableSessions = [...chatSessions.entries()]
        .filter((entry) => isEvictableChatSession(entry[1]))
        .sort((left, right) => left[1].lastAccessedAtMs - right[1].lastAccessedAtMs);
    const overflowCount = chatSessions.size - ASSISTANT_CHAT_SESSION_MAX_ENTRIES;
    for (let index = 0; index < overflowCount; index += 1) {
        const entry = evictableSessions[index];
        if (!entry) {
            break;
        }
        deleteChatSession(entry[0], 'evicted');
    }
}

function getChatSession(scope: IAgentAssistantChatScope, selection: IAssistantSelection, options: { create: true }): IAssistantChatSession;
function getChatSession(scope: IAgentAssistantChatScope | null, selection?: IAssistantSelection, options?: { create?: false }): IAssistantChatSession | null;
function getChatSession(
    scope: IAgentAssistantChatScope | null,
    selection: IAssistantSelection = {
        provider: lastStateProvider,
        model: lastStateModel,
        effort: lastStateEffort,
        speedMode: lastStateSpeedMode,
    },
    options: { create?: boolean } = {},
) {
    const now = Date.now();
    pruneChatSessions(now);
    if (!scope) {
        return null;
    }

    const normalizedScope = normalizeAssistantScope(scope);
    if (!normalizedScope) {
        return null;
    }

    const sessionKey = createChatSessionKey(selection.provider, normalizedScope.key);
    const existing = chatSessions.get(sessionKey);
    if (existing) {
        existing.scope = normalizedScope;
        existing.model = selection.model;
        existing.effort = selection.effort;
        existing.speedMode = selection.speedMode;
        return touchChatSession(existing, now);
    }

    if (!options.create) {
        return null;
    }

    const session = {
        provider: selection.provider,
        scope: normalizedScope,
        model: selection.model,
        effort: selection.effort,
        speedMode: selection.speedMode,
        threadId: null,
        activeTurnId: null,
        turnPhase: 'idle',
        messages: [],
        lastAccessedAtMs: now,
        claudeSession: undefined,
    } satisfies IAssistantChatSession;
    chatSessions.set(sessionKey, session);
    pruneChatSessions(now);
    return session;
}

function getActiveChatSession(provider?: TAgentAssistantProviderId) {
    const session = activeChatKey ? chatSessions.get(activeChatKey) ?? null : null;
    if (provider && session?.provider !== provider) {
        return null;
    }
    return session ? touchChatSession(session) : null;
}

function getChatSessionByThreadId(candidateThreadId: string | null) {
    if (!candidateThreadId) {
        return null;
    }

    const session = Array.from(chatSessions.values())
        .find(candidate => candidate.provider === 'codex' && candidate.threadId === candidateThreadId) ?? null;
    return session ? touchChatSession(session) : null;
}

function getRequestChatSession(request?: IAgentAssistantStateRequest | IAgentAssistantScopedRequest | null) {
    const scope = resolveRequestedScope(request);
    const selection = resolveAssistantSelection(codexAssistantModels, request);
    rememberStateScope(scope, selection);
    return scope ? getChatSession(scope, selection, { create: true }) : null;
}

async function writeAssistantConfig(codeHome: string, serverUrl: string, reasoningEffort: TAgentAssistantEffort) {
    await mkdir(codeHome, { recursive: true });
    await writeFile(join(codeHome, 'config.toml'), createAssistantCodexConfig(serverUrl, reasoningEffort), 'utf-8');
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

function decodeRecordResponse(value: unknown): Record<PropertyKey, unknown> | null {
    return isRecord(value) ? value : null;
}

function getCodexAppServerModel(model: string | null | undefined) {
    return normalizeCodexAssistantModel(codexAssistantModels, model);
}

function currentCodexSelection(): IAssistantSelection {
    const model = lastStateProvider === 'codex' ? lastStateModel : codexDefaultModelId(codexAssistantModels);
    return {
        provider: 'codex',
        model,
        effort: normalizeAssistantEffort('codex', lastStateProvider === 'codex' ? lastStateEffort : ASSISTANT_DEFAULT_EFFORT),
        speedMode: normalizeAssistantSpeedMode(
            codexAssistantModels,
            'codex',
            model,
            lastStateProvider === 'codex' ? lastStateSpeedMode : ASSISTANT_DEFAULT_SPEED_MODE,
        ),
    };
}

function getSessionForStatus(scope: IAgentAssistantChatScope | null, selection: IAssistantSelection) {
    return getChatSession(scope, selection);
}

function currentStatus(
    scope: IAgentAssistantChatScope | null = lastStateScope,
    selection: IAssistantSelection = {
        provider: lastStateProvider,
        model: lastStateModel,
        effort: lastStateEffort,
        speedMode: lastStateSpeedMode,
    },
): IAgentAssistantStatus {
    const codexInfo = codexInfoCache;
    const installed = codexInfo?.installed === true;
    const versionSupported = codexInfo?.isVersionSupported === true;
    const supported = process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux';
    const normalizedSelection = {
        provider: selection.provider,
        model: normalizeAssistantModel(codexAssistantModels, selection.provider, selection.model),
        effort: normalizeAssistantEffort(selection.provider, selection.effort),
        speedMode: normalizeAssistantSpeedMode(codexAssistantModels, selection.provider, selection.model, selection.speedMode),
    } as const satisfies IAssistantSelection;
    const session = getSessionForStatus(scope, normalizedSelection);
    const activeProviderRuntime = getAssistantProviderRuntimeState(providerRuntimeStates, normalizedSelection.provider);
    const fallbackTurnPhase = activeProviderRuntime.turnPhase;
    const sessionTurnPhase = session?.turnPhase ?? fallbackTurnPhase;
    const sessionActiveTurnId = session?.activeTurnId ?? activeProviderRuntime.activeTurnId;
    const sessionThreadId = session?.threadId ?? null;
    const effortInput = session?.effort ?? normalizedSelection.effort;
    const speedModeInput = session?.speedMode ?? normalizedSelection.speedMode;
    const providerStatuses = buildAssistantProviderStatuses({
        platform: process.platform,
        states: providerRuntimeStates,
        codexInfo,
        claudeInfo: claudeInfoCache,
        codexModels: codexAssistantModels,
        claudeModels: claudeAssistantModels,
        model: session?.model ?? normalizedSelection.model,
        effort: effortInput,
        speedMode: speedModeInput,
    });
    const activeProvider = providerStatuses.find(provider => provider.id === normalizedSelection.provider) ?? providerStatuses[0]!;
    const model = normalizeAssistantModel(
        codexAssistantModels,
        normalizedSelection.provider,
        session?.model ?? normalizedSelection.model,
    );
    const models = activeProvider.models;
    const effort = normalizeAssistantEffort(normalizedSelection.provider, effortInput);
    const speedMode = normalizeAssistantSpeedMode(codexAssistantModels, normalizedSelection.provider, model, speedModeInput);
    const error = session?.lastError ?? activeProvider.error;
    return {
        supported,
        platform: process.platform,
        provider: activeProvider.id,
        providerLabel: activeProvider.label,
        providers: providerStatuses,
        model,
        modelLabel: getProviderModelLabel(codexAssistantModels, claudeAssistantModels, normalizedSelection.provider, model),
        models,
        modelSwitchMode: activeProvider.modelSwitchMode,
        effort,
        availableEfforts: getProviderEfforts(normalizedSelection.provider),
        speedMode,
        availableSpeedModes: getProviderSpeedModes(codexAssistantModels, normalizedSelection.provider, model),
        installState: activeProvider.installState,
        codexInstalled: installed,
        codexPath: codexInfo?.path ?? null,
        codexVersion: codexInfo?.version ?? null,
        minimumCodexVersion: codexInfo?.minimumVersion ?? '0.133.0',
        codexVersionSupported: versionSupported,
        installUrl: CODEX_APP_INSTALL_URL,
        installScriptUrl: CODEX_STANDALONE_INSTALL_URL,
        managedInstallDir: codexInfo?.managedInstallDir ?? '',
        authState: activeProvider.authState,
        account: activeProvider.account,
        runtimeState: activeProvider.runtimeState,
        mcp: createBaseMcpStatusWithToolCount(normalizedSelection.provider),
        turn: {
            id: sessionActiveTurnId,
            phase: sessionTurnPhase,
        },
        threadId: sessionThreadId,
        activeTurnId: sessionActiveTurnId,
        lastCheckedAt: new Date().toISOString(),
        ...(error
            ? {
                error,
                errorEnvelope: createAssistantErrorEnvelope(error),
            }
            : {}),
    };
}

function cloneAssistantAttachment(attachment: IAgentAssistantImageAttachment): IAgentAssistantImageAttachment {
    return { ...attachment };
}

function cloneAssistantMessage(message: IAgentAssistantChatMessage): IAgentAssistantChatMessage {
    return withAssistantErrorEnvelope({
        ...message,
        ...(message.attachments === undefined
            ? {}
            : { attachments: message.attachments.map(cloneAssistantAttachment) }),
    });
}

function cloneMessages(
    scope: IAgentAssistantChatScope | null = lastStateScope,
    selection: IAssistantSelection = {
        provider: lastStateProvider,
        model: lastStateModel,
        effort: lastStateEffort,
        speedMode: lastStateSpeedMode,
    },
) {
    return getChatSession(scope, selection)?.messages.map(cloneAssistantMessage) ?? [];
}

function currentState(
    scope: IAgentAssistantChatScope | null = lastStateScope,
    selection: IAssistantSelection = {
        provider: lastStateProvider,
        model: lastStateModel,
        effort: lastStateEffort,
        speedMode: lastStateSpeedMode,
    },
): IAgentAssistantState {
    return {
        scope: scope ? cloneAssistantScope(scope) : null,
        status: currentStatus(scope, selection),
        messages: cloneMessages(scope, selection),
    };
}

function shouldAttachStateToAssistantEvent(event: IAgentAssistantEvent) {
    return event.state !== undefined
        || event.type === 'state'
        || event.type === 'message'
        || event.type === 'turn-started'
        || event.type === 'turn-completed'
        || event.type === 'error';
}

function publishAssistantEvent(
    event: IAgentAssistantEvent,
    scope: IAgentAssistantChatScope | null = lastStateScope,
    selection: IAssistantSelection = {
        provider: lastStateProvider,
        model: lastStateModel,
        effort: lastStateEffort,
        speedMode: lastStateSpeedMode,
    },
) {
    const normalizedEvent = withAssistantErrorEnvelope(event);
    const payload = {
        ...normalizedEvent,
        ...(shouldAttachStateToAssistantEvent(normalizedEvent)
            ? { state: normalizedEvent.state ?? currentState(scope, selection) }
            : {}),
    } satisfies IAgentAssistantEvent;
    for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) {
            continue;
        }
        window.webContents.send(CORE_IPC_EVENT_CHANNELS.agentAssistantEvent, payload);
    }
}

function publishState(
    scope: IAgentAssistantChatScope | null = lastStateScope,
    selection: IAssistantSelection = {
        provider: lastStateProvider,
        model: lastStateModel,
        effort: lastStateEffort,
        speedMode: lastStateSpeedMode,
    },
) {
    publishAssistantEvent({
        type: 'state',
        state: currentState(scope, selection),
    }, scope, selection);
}

function addMessage(
    session: IAssistantChatSession,
    message: Omit<IAgentAssistantChatMessage, 'id' | 'createdAt'> & { id?: string },
) {
    touchChatSession(session);
    const nextMessage = {
        id: message.id ?? randomUUID(),
        role: message.role,
        text: message.text,
        createdAt: new Date().toISOString(),
        ...(message.attachments === undefined
            ? {}
            : { attachments: message.attachments.map(cloneAssistantAttachment) }),
        ...(message.pending === undefined ? {} : { pending: message.pending }),
        ...(message.error === undefined ? {} : { error: message.error }),
    } satisfies IAgentAssistantChatMessage;
    session.messages.push(nextMessage);
    publishAssistantEvent({
        type: 'message',
        message: nextMessage,
    }, session.scope, session);
    return nextMessage;
}

function upsertAssistantMessage(
    session: IAssistantChatSession,
    id: string,
    patch: Partial<IAgentAssistantChatMessage>,
) {
    touchChatSession(session);
    const existing = session.messages.find(message => message.id === id);
    if (existing) {
        Object.assign(existing, patch);
        publishAssistantEvent({
            type: 'message',
            message: cloneAssistantMessage(existing),
        }, session.scope, session);
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
    touchChatSession(session);
    const message = session.messages.find(candidate => candidate.id === messageId)
        ?? addMessage(session, {
            id: messageId,
            role: 'assistant',
            text: '',
            pending: true,
        });
    message.pending = true;
    message.text += delta;
    publishAssistantEvent({
        type: 'message-delta',
        messageId,
        delta,
    }, session.scope, session);
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
    return getChatSessionByThreadId(getNotificationThreadId(params)) ?? getActiveChatSession('codex');
}

function handleAppServerNotification(notification: ICodexAppServerNotification) {
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
        codexProviderRuntime.authState = success ? 'signed-in' : 'signed-out';
        if (success) {
            delete codexProviderRuntime.lastError;
        } else {
            codexProviderRuntime.lastError = error ?? 'ChatGPT sign-in failed.';
        }
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
        activeChatKey = createChatSessionKey(session.provider, session.scope.key);
        codexProviderRuntime.activeTurnId = session.activeTurnId;
        codexProviderRuntime.runtimeState = 'busy';
        codexProviderRuntime.turnPhase = 'running';
        session.turnPhase = 'running';
        publishAssistantEvent({
            type: 'turn-started',
            ...(codexProviderRuntime.activeTurnId ? { turnId: codexProviderRuntime.activeTurnId } : {}),
        }, session.scope, session);
        return;
    }

    if (method === 'turn/completed') {
        const session = getNotificationChatSession(params);
        if (!session) {
            return;
        }
        session.activeTurnId = null;
        session.turnPhase = 'idle';
        codexProviderRuntime.activeTurnId = null;
        codexProviderRuntime.runtimeState = 'ready';
        codexProviderRuntime.turnPhase = 'idle';
        for (const message of session.messages) {
            if (message.role === 'assistant' && message.pending) {
                message.pending = false;
            }
        }
        publishAssistantEvent({ type: 'turn-completed' }, session.scope, session);
        return;
    }

    if (method === 'item/agentMessage/delta') {
        const session = getNotificationChatSession(params);
        if (!session) {
            return;
        }
        const itemId = getStringParam(params, 'itemId');
        const delta = getStringParam(params, 'delta');
        if (codexProviderRuntime.runtimeState === 'busy') {
            codexProviderRuntime.turnPhase = 'running';
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
                pending: codexProviderRuntime.runtimeState === 'busy',
            });
        }
        return;
    }

    if (method === 'error') {
        const session = getNotificationChatSession(params);
        codexProviderRuntime.lastError = isRecord(params) && isRecord(params.error) && typeof params.error.message === 'string'
            ? params.error.message
            : 'Codex assistant turn failed.';
        if (session) {
            session.lastError = codexProviderRuntime.lastError;
            session.activeTurnId = null;
            session.turnPhase = 'error';
        }
        codexProviderRuntime.runtimeState = 'error';
        codexProviderRuntime.turnPhase = 'error';
        codexProviderRuntime.activeTurnId = null;
        if (session) {
            reconcileFailedTurnMessages(session, codexProviderRuntime.lastError);
            addMessage(session, {
                role: 'system',
                text: codexProviderRuntime.lastError,
                error: codexProviderRuntime.lastError,
            });
        }
        publishAssistantEvent({
            type: 'error',
            error: codexProviderRuntime.lastError,
        }, session?.scope ?? lastStateScope, session ?? currentCodexSelection());
    }
}

function handleAppServerExit(message: string) {
    const session = getActiveChatSession('codex');
    runtime = null;
    codexProviderRuntime.runtimeState = 'error';
    codexProviderRuntime.turnPhase = 'error';
    codexProviderRuntime.activeTurnId = null;
    for (const chatSession of chatSessions.values()) {
        if (chatSession.provider !== 'codex') {
            continue;
        }
        chatSession.threadId = null;
        chatSession.activeTurnId = null;
    }
    if (session) {
        session.turnPhase = 'error';
        session.lastError = message;
    }
    codexProviderRuntime.lastError = message;
    publishAssistantEvent({
        type: 'error',
        error: message,
    }, session?.scope ?? lastStateScope, session ?? currentCodexSelection());
}

async function refreshCodexInfo() {
    codexInfoCache = await getCodexCliInfo();
    return codexInfoCache;
}

function hasActiveClaudeSession() {
    for (const session of chatSessions.values()) {
        if (session.provider === 'claude' && session.claudeSession) {
            return true;
        }
    }
    return false;
}

async function refreshClaudeInfo() {
    claudeInfoCache = await getClaudeAgentSdkInfo();
    if (claudeInfoCache.installed) {
        if (!(hasActiveClaudeSession() && claudeProviderRuntime.authState === 'signed-in')) {
            const detected = await detectClaudeAuthState();
            // A 'signed-out' demotion (from a real auth failure) is sticky: an
            // inconclusive 'unknown' must not silently re-mark the account as usable.
            // Only positive evidence ('signed-in') clears it.
            if (detected === 'signed-in' || claudeProviderRuntime.authState !== 'signed-out') {
                claudeProviderRuntime.authState = detected;
            }
        }
        claudeProviderRuntime.runtimeState = claudeProviderRuntime.runtimeState === 'stopped'
            ? 'ready'
            : claudeProviderRuntime.runtimeState;
        if (claudeProviderRuntime.authState !== 'signed-out') {
            delete claudeProviderRuntime.lastError;
        }
    } else {
        claudeProviderRuntime.authState = 'unknown';
        claudeProviderRuntime.runtimeState = 'stopped';
        claudeProviderRuntime.turnPhase = 'idle';
        claudeProviderRuntime.account = null;
        claudeProviderRuntime.activeTurnId = null;
        if (claudeInfoCache.error) {
            claudeProviderRuntime.lastError = claudeInfoCache.error;
        } else {
            delete claudeProviderRuntime.lastError;
        }
    }
    return claudeInfoCache;
}

async function refreshAuthState() {
    if (!runtime) {
        codexProviderRuntime.authState = 'unknown';
        codexProviderRuntime.account = null;
        return;
    }

    let accountReadError: unknown;
    try {
        const accountResponse = await runtime.client.requestDecoded(
            'account/read',
            { refreshToken: true },
            decodeRecordResponse,
            CODEX_AUTH_ACCOUNT_READ_TIMEOUT_MS,
        );
        const normalizedAccount = normalizeCodexAssistantAccount(accountResponse.account);
        if (normalizedAccount) {
            codexProviderRuntime.authState = 'signed-in';
            codexProviderRuntime.account = normalizedAccount;
            delete codexProviderRuntime.lastError;
            return;
        }

        const accountRequiresOpenaiAuth = accountResponse.requiresOpenaiAuth === true;
        if (accountRequiresOpenaiAuth) {
            codexProviderRuntime.authState = 'signed-out';
            codexProviderRuntime.account = null;
            delete codexProviderRuntime.lastError;
            return;
        }
    } catch (error) {
        accountReadError = error;
        logger.warn(`Failed to read Codex account state; falling back to auth status: ${getErrorMessage(error)}`);
    }

    try {
        const authStatus = await runtime.client.requestDecoded(
            'getAuthStatus',
            {
                includeToken: false,
                refreshToken: accountReadError === undefined,
            },
            decodeRecordResponse,
            CODEX_AUTH_STATUS_TIMEOUT_MS,
        );
        applyCodexAuthStatusResponse(codexProviderRuntime, authStatus);
    } catch (error) {
        const message = accountReadError === undefined
            ? getErrorMessage(error)
            : `${getErrorMessage(accountReadError)}; ${getErrorMessage(error)}`;
        logger.warn(`Failed to read Codex auth state: ${message}`);
        codexProviderRuntime.authState = codexProviderRuntime.authState === 'signed-in' ? 'signed-in' : 'signed-out';
        codexProviderRuntime.account = null;
        if (codexProviderRuntime.authState !== 'signed-in') {
            codexProviderRuntime.lastError = `Could not verify Codex authentication: ${message}`;
        }
    }
}

function syncRuntimeStateAfterAuthCheck(options: { recoverFromError?: boolean } = {}) {
    if (!runtime || codexProviderRuntime.runtimeState === 'busy') {
        return;
    }
    if (codexProviderRuntime.runtimeState === 'error' && !options.recoverFromError) {
        return;
    }

    codexProviderRuntime.runtimeState = codexProviderRuntime.authState === 'signed-in' ? 'ready' : 'stopped';
    codexProviderRuntime.turnPhase = 'idle';
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

    if (runtimeStartPromise) {
        return runtimeStartPromise;
    }

    if (runtime) {
        if (
            runtime.mcpServerName === ASSISTANT_MCP_SERVER_NAME
            && runtime.mcpContractVersion === ASSISTANT_MCP_CONTRACT_VERSION
        ) {
            return runtime;
        }
        logger.info('Restarting Codex assistant runtime for updated embedded MCP contract.');
        await shutdownCodexAssistantRuntime();
    }

    if (runtime) {
        return runtime;
    }

    const startPromise = startAssistantRuntime().finally(() => {
        if (runtimeStartPromise === startPromise) {
            runtimeStartPromise = null;
        }
    });
    runtimeStartPromise = startPromise;
    return startPromise;
}

async function startAssistantRuntime() {
    codexProviderRuntime.runtimeState = 'starting';
    codexProviderRuntime.turnPhase = 'idle';
    delete codexProviderRuntime.lastError;
    publishState(lastStateScope, currentCodexSelection());

    const codexInfo = await refreshCodexInfo();
    if (!codexInfo.installed || !codexInfo.path) {
        codexProviderRuntime.runtimeState = 'stopped';
        codexProviderRuntime.turnPhase = 'idle';
        codexProviderRuntime.authState = 'unknown';
        publishState(lastStateScope, currentCodexSelection());
        throw new Error('Codex is not installed.');
    }
    if (!codexInfo.isVersionSupported) {
        codexProviderRuntime.runtimeState = 'error';
        codexProviderRuntime.turnPhase = 'error';
        codexProviderRuntime.lastError = `Codex ${codexInfo.version ?? ''} is too old. EVB Assistant requires Codex ${codexInfo.minimumVersion} or newer.`;
        publishState(lastStateScope, currentCodexSelection());
        throw new Error(codexProviderRuntime.lastError);
    }

    const codeHome = getAssistantCodexHome();
    const cwd = getAssistantCwd();
    await mkdir(cwd, { recursive: true });
    const codexEffort = normalizeAssistantEffort('codex', lastStateProvider === 'codex' ? lastStateEffort : ASSISTANT_DEFAULT_EFFORT);
    const {
        descriptor,
        token: mcpToken,
    } = await ensureSharedEmbeddedMcp();
    await writeAssistantConfig(codeHome, descriptor.url, codexEffort);

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
    const nextRuntime = {
        client,
        codexPath: codexInfo.path,
        codeHome,
        cwd,
        mcpToken,
        mcpServerName: ASSISTANT_MCP_SERVER_NAME,
        mcpContractVersion: ASSISTANT_MCP_CONTRACT_VERSION,
        effort: codexEffort,
    } satisfies IAssistantRuntime;
    runtime = nextRuntime;

    try {
        await client.initialize();
        await refreshAuthState();
        syncRuntimeStateAfterAuthCheck();
        await refreshCodexModelList();
        await refreshMcpToolCount();
        publishState(lastStateScope, currentCodexSelection());
        return nextRuntime;
    } catch (error) {
        client.shutdown();
        runtime = null;
        codexProviderRuntime.runtimeState = 'error';
        codexProviderRuntime.turnPhase = 'error';
        codexProviderRuntime.lastError = getErrorMessage(error);
        publishState(lastStateScope, currentCodexSelection());
        throw error;
    }
}

async function refreshMcpToolCount() {
    if (!runtime) {
        return;
    }

    try {
        const response = await runtime.client.requestDecoded(
            'mcpServerStatus/list',
            {detail: 'toolsAndAuthOnly'},
            decodeRecordResponse,
        );
        if (!Array.isArray(response.data)) {
            return;
        }
        const servers: unknown[] = response.data;
        const server = servers.find(candidate => isRecord(candidate) && candidate.name === ASSISTANT_MCP_SERVER_NAME);
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

async function refreshCodexModelList() {
    if (!runtime) {
        return;
    }

    try {
        const response = await runtime.client.requestDecoded(
            'model/list',
            { includeHidden: false },
            normalizeCodexModelListResponse,
        );
        if (response.length > 0) {
            codexAssistantModels = response;
            lastStateModel = normalizeAssistantModel(codexAssistantModels, lastStateProvider, lastStateModel);
        }
    } catch (error) {
        logger.warn(`Failed to read Codex model list: ${getErrorMessage(error)}`);
    }
}

let mcpToolCount = 0;
let claudeMcpToolCount = 0;

function createBaseMcpStatusWithToolCount(provider: TAgentAssistantProviderId = lastStateProvider) {
    const base = createBaseMcpStatus();
    return {
        ...base,
        toolCount: provider === 'claude' ? claudeMcpToolCount : mcpToolCount,
    };
}

async function ensureAssistantThread(session: IAssistantChatSession) {
    const currentRuntime = await ensureAssistantRuntime();
    if (codexProviderRuntime.authState !== 'signed-in') {
        throw new Error('Sign in with ChatGPT before using EVB Assistant.');
    }
    if (session.threadId) {
        return session.threadId;
    }

    const codexModel = getCodexAppServerModel(session.model);
    const response = await currentRuntime.client.requestDecoded('thread/start', {
        ...(codexModel ? { model: codexModel } : {}),
        cwd: currentRuntime.cwd,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        serviceName: 'EVB Assistant',
        developerInstructions: ASSISTANT_ROLE_PROMPT,
        personality: 'friendly',
        ephemeral: true,
        threadSource: 'user',
    }, decodeRecordResponse);
    if (!isRecord(response.thread) || typeof response.thread.id !== 'string') {
        throw new Error('Codex did not return an assistant thread.');
    }
    session.threadId = response.thread.id;
    session.activeTurnId = null;
    session.turnPhase = 'idle';
    activeChatKey = createChatSessionKey(session.provider, session.scope.key);
    codexProviderRuntime.runtimeState = 'ready';
    codexProviderRuntime.turnPhase = 'idle';
    publishState(session.scope, session);
    return session.threadId;
}

function markClaudeTurnCompleted(session: IAssistantChatSession, turnId: string | null) {
    if (turnId && session.activeTurnId && session.activeTurnId !== turnId) {
        return;
    }

    session.activeTurnId = null;
    session.turnPhase = 'idle';
    claudeProviderRuntime.activeTurnId = null;
    claudeProviderRuntime.turnPhase = 'idle';
    claudeProviderRuntime.runtimeState = 'ready';
    for (const message of session.messages) {
        if (message.role === 'assistant' && message.pending) {
            message.pending = false;
        }
    }
    publishAssistantEvent({ type: 'turn-completed' }, session.scope, session);
}

function reconcileFailedTurnMessages(session: IAssistantChatSession, errorMessage: string) {
    const normalizedError = errorMessage.trim();
    session.messages = session.messages.filter((message) => {
        if (message.role !== 'assistant' || !message.pending) {
            return true;
        }
        const text = message.text.trim();
        // Drop the incomplete streaming bubble when it is empty or just echoes the error
        // (e.g. an unavailable-model notice), so the failure is not shown twice.
        return text.length > 0
            && !normalizedError.includes(text)
            && !text.includes(normalizedError);
    });
    for (const message of session.messages) {
        if (message.role === 'assistant' && message.pending) {
            message.pending = false;
        }
    }
}

function markClaudeTurnError(session: IAssistantChatSession, message: string) {
    claudeProviderRuntime.lastError = message;
    claudeProviderRuntime.runtimeState = 'error';
    claudeProviderRuntime.turnPhase = 'error';
    claudeProviderRuntime.activeTurnId = null;
    if (isClaudeAuthErrorMessage(message)) {
        claudeProviderRuntime.authState = 'signed-out';
    }
    session.activeTurnId = null;
    session.turnPhase = 'error';
    session.lastError = message;
    reconcileFailedTurnMessages(session, message);
    addMessage(session, {
        role: 'system',
        text: message,
        error: message,
    });
    publishAssistantEvent({
        type: 'error',
        error: message,
    }, session.scope, session);
}

function createClaudeCallbacks(session: IAssistantChatSession) {
    return {
        onInitialized: (info: IClaudeAgentAssistantInit) => {
            session.threadId = info.sessionId;
            session.model = normalizeClaudeAssistantModel(info.model ?? session.model);
            if (info.models && info.models.length > 0) {
                claudeAssistantModels = info.models;
                session.model = normalizeClaudeAssistantModel(session.model);
            }
            claudeMcpToolCount = Math.max(claudeMcpToolCount, info.toolCount);
            claudeProviderRuntime.account = normalizeClaudeAssistantAccount(info.account);
            claudeProviderRuntime.authState = 'signed-in';
            if (claudeProviderRuntime.runtimeState !== 'busy') {
                claudeProviderRuntime.runtimeState = 'ready';
                claudeProviderRuntime.turnPhase = 'idle';
            }
            publishState(session.scope, session);
        },
        onTurnStarted: (turnId: string) => {
            activeChatKey = createChatSessionKey(session.provider, session.scope.key);
            session.activeTurnId = turnId;
            session.turnPhase = 'running';
            claudeProviderRuntime.activeTurnId = turnId;
            claudeProviderRuntime.turnPhase = 'running';
            claudeProviderRuntime.runtimeState = 'busy';
            publishAssistantEvent({
                type: 'turn-started',
                turnId,
            }, session.scope, session);
        },
        onAssistantDelta: (messageId: string, delta: string) => {
            if (claudeProviderRuntime.runtimeState === 'busy') {
                claudeProviderRuntime.turnPhase = 'running';
                session.turnPhase = 'running';
            }
            appendAssistantDelta(session, messageId, delta);
        },
        onAssistantMessage: (messageId: string, text: string, pending: boolean) => {
            upsertAssistantMessage(session, messageId, {
                text,
                pending,
            });
        },
        onTurnCompleted: (turnId: string | null) => {
            markClaudeTurnCompleted(session, turnId);
        },
        onError: (message: string) => {
            markClaudeTurnError(session, message);
        },
    };
}

async function ensureClaudeAssistantSession(
    session: IAssistantChatSession,
    model: string,
    effort: TAgentAssistantEffort,
    speedMode: TAgentAssistantSpeedMode,
) {
    if (!(await isAssistantFeatureEnabled())) {
        await shutdownAgentAssistant();
        throw new Error(createAssistantDisabledError());
    }

    const claudeInfo = await refreshClaudeInfo();
    if (!claudeInfo.installed || !claudeInfo.executablePath) {
        const error = claudeInfo.error ?? 'Claude Agent SDK is not available.';
        claudeProviderRuntime.lastError = error;
        claudeProviderRuntime.runtimeState = 'stopped';
        claudeProviderRuntime.turnPhase = 'idle';
        publishState(session.scope, session);
        throw new Error(error);
    }

    const normalizedModel = normalizeClaudeAssistantModel(model);
    const normalizedEffort = normalizeAssistantEffort('claude', effort);
    const normalizedSpeedMode = normalizeAssistantSpeedMode(codexAssistantModels, 'claude', normalizedModel, speedMode);
    const desiredFastMode = shouldUseClaudeAssistantFastMode(normalizedModel, normalizedSpeedMode);

    if (session.claudeSession) {
        // The model can change in-session (setModel), but effort and flag settings
        // are fixed at query() start. Keep local message history and rebuild only
        // when the SDK session configuration would differ.
        if (
            session.claudeSession.effort === normalizedEffort
            && session.claudeSession.fastMode === desiredFastMode
        ) {
            session.model = normalizedModel;
            session.effort = normalizedEffort;
            session.speedMode = normalizedSpeedMode;
            return session.claudeSession;
        }
        await session.claudeSession.close().catch((error: unknown) => {
            logger.warn(`Failed to close Claude assistant session for settings change: ${getErrorMessage(error)}`);
        });
        session.claudeSession = undefined;
        session.threadId = null;
        session.activeTurnId = null;
        session.turnPhase = 'idle';
    }

    claudeProviderRuntime.runtimeState = 'starting';
    claudeProviderRuntime.turnPhase = 'idle';
    delete claudeProviderRuntime.lastError;
    publishState(session.scope, session);
    const cwd = getAssistantCwd();
    await mkdir(cwd, { recursive: true });
    const {
        descriptor,
        token: mcpToken,
    } = await ensureSharedEmbeddedMcp();
    session.model = normalizedModel;
    session.effort = normalizedEffort;
    session.speedMode = normalizedSpeedMode;
    session.claudeSession = new ClaudeAgentAssistantSession({
        cwd,
        model: session.model,
        effort: session.effort,
        speedMode: session.speedMode,
        mcpServerName: ASSISTANT_MCP_SERVER_NAME,
        mcpServerUrl: descriptor.url,
        mcpToken,
        executablePath: claudeInfo.executablePath,
        callbacks: createClaudeCallbacks(session),
    });
    claudeProviderRuntime.runtimeState = 'ready';
    claudeProviderRuntime.turnPhase = 'idle';
    publishState(session.scope, session);
    return session.claudeSession;
}

export async function getAgentAssistantState(
    request?: IAgentAssistantStateRequest,
): Promise<IAgentAssistantState> {
    const session = getRequestChatSession(request);
    const scope = session?.scope ?? null;
    const selection = resolveAssistantSelection(codexAssistantModels, request);
    if (!(await isAssistantFeatureEnabled())) {
        await shutdownAgentAssistant();
        return currentState(scope, selection);
    }

    if (selection.provider === 'claude') {
        await refreshClaudeInfo();
        return currentState(scope, selection);
    }

    if (selection.provider === 'codex') {
        await refreshCodexInfo();
        if (codexInfoCache?.installed && codexInfoCache.isVersionSupported) {
            try {
                await ensureAssistantRuntime();
                await refreshAuthStateAndRuntimeAvailability();
            } catch (error) {
                logger.warn(`Assistant runtime is not ready: ${getErrorMessage(error)}`);
            }
        }
    }
    return currentState(scope, selection);
}

export async function installAgentAssistantCodex(): Promise<IAgentAssistantInstallResult> {
    if (!(await isAssistantFeatureEnabled())) {
        const error = await stopAssistantForDisabledFeature();
        return withAssistantErrorEnvelope({
            ok: false,
            state: currentState(),
            error,
        });
    }

    if (installPromise) {
        return installPromise;
    }

    installPromise = (async () => {
        try {
            delete codexProviderRuntime.lastError;
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
            codexProviderRuntime.lastError = getErrorMessage(error);
            codexProviderRuntime.runtimeState = 'error';
            codexProviderRuntime.turnPhase = 'error';
            publishAssistantEvent({
                type: 'error',
                error: codexProviderRuntime.lastError,
            });
            return withAssistantErrorEnvelope({
                ok: false,
                state: currentState(),
                error: codexProviderRuntime.lastError,
            });
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
        const response = await currentRuntime.client.requestDecoded('account/login/start', params, decodeRecordResponse);
        if (typeof response.type !== 'string') {
            throw new Error('Codex did not return a login flow.');
        }

        pendingLoginId = typeof response.loginId === 'string' ? response.loginId : null;
        codexProviderRuntime.authState = 'login-pending';
        rememberAssistantReturnWindow(parentWindow);
        const authUrl = typeof response.authUrl === 'string' ? response.authUrl : undefined;
        const verificationUrl = typeof response.verificationUrl === 'string' ? response.verificationUrl : undefined;
        const urlToOpen = authUrl ?? verificationUrl;
        if (urlToOpen) {
            await shell.openExternal(sanitizeAllowedExternalUrl(urlToOpen));
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
        codexProviderRuntime.lastError = getErrorMessage(error);
        codexProviderRuntime.authState = 'signed-out';
        publishAssistantEvent({
            type: 'error',
            error: codexProviderRuntime.lastError,
        });
        return withAssistantErrorEnvelope({
            ok: false,
            state: currentState(),
            error: codexProviderRuntime.lastError,
        });
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
        return withAssistantErrorEnvelope({
            ok: false,
            state: currentState(),
            error,
        });
    }

    const selection = resolveAssistantSelection(codexAssistantModels, request);
    const scope = normalizeAssistantScope(request.scope);
    rememberStateScope(scope, selection);
    if (!scope) {
        const error = 'Open a document before starting an EVB Assistant chat.';
        if (selection.provider === 'claude') {
            claudeProviderRuntime.lastError = error;
        } else {
            codexProviderRuntime.lastError = error;
        }
        return withAssistantErrorEnvelope({
            ok: false,
            state: currentState(null, selection),
            error,
        });
    }
    const session = getChatSession(scope, selection, { create: true });

    let normalizedRequest: ReturnType<typeof normalizeOutgoingMessageRequest>;
    try {
        normalizedRequest = normalizeOutgoingMessageRequest(request);
    } catch (error) {
        const message = getErrorMessage(error);
        if (selection.provider === 'claude') {
            claudeProviderRuntime.lastError = message;
        } else {
            codexProviderRuntime.lastError = message;
        }
        session.lastError = message;
        return withAssistantErrorEnvelope({
            ok: false,
            state: currentState(session.scope, session),
            error: message,
        });
    }

    const {
        text,
        attachments,
    } = normalizedRequest;
    // Preset chips send a short visible label as `text` and carry the detailed,
    // edge-case-aware workflow as hidden instructions. The transcript records the
    // short label, while the model receives the label plus the full workflow.
    const presetInstructions = resolveAssistantPresetInstructions(request.presetId);
    const modelText = presetInstructions
        ? (text ? `${text}\n\n${presetInstructions}` : presetInstructions)
        : text;
    if (!text && attachments.length === 0 && !presetInstructions) {
        return withAssistantErrorEnvelope({
            ok: false,
            state: currentState(session.scope, session),
            error: 'Message is empty.',
        });
    }

    if (selection.provider === 'claude') {
        try {
            const claudeSession = await ensureClaudeAssistantSession(
                session,
                selection.model,
                selection.effort,
                selection.speedMode,
            );
            activeChatKey = createChatSessionKey(session.provider, session.scope.key);
            claudeProviderRuntime.runtimeState = 'busy';
            claudeProviderRuntime.turnPhase = 'starting';
            session.turnPhase = 'starting';
            session.activeTurnId = null;
            claudeProviderRuntime.activeTurnId = null;
            delete session.lastError;
            addMessage(session, {
                role: 'user',
                text,
                ...(attachments.length > 0 ? { attachments } : {}),
            });
            publishState(session.scope, session);
            await claudeSession.sendMessage(modelText, attachments, selection.model);
            publishState(session.scope, session);
            return {
                ok: true,
                state: currentState(session.scope, session),
            };
        } catch (error) {
            const message = getErrorMessage(error);
            markClaudeTurnError(session, message);
            return withAssistantErrorEnvelope({
                ok: false,
                state: currentState(session.scope, session),
                error: message,
            });
        }
    }

    let currentThreadId: string | null = null;
    try {
        // Codex effort is a runtime-level config (model_reasoning_effort); apply a change by
        // restarting the runtime so the next ensureAssistantRuntime rewrites config.toml.
        if (runtime && runtime.effort !== selection.effort) {
            await shutdownCodexAssistantRuntime();
        }
        const currentRuntime = await ensureAssistantRuntime();
        const codexModel = getCodexAppServerModel(selection.model);
        const codexServiceTier = resolveCodexServiceTier(codexAssistantModels, selection.model, selection.speedMode);
        session.model = normalizeCodexAssistantModel(codexAssistantModels, selection.model);
        session.effort = selection.effort;
        session.speedMode = selection.speedMode;
        currentThreadId = await ensureAssistantThread(session);
        activeChatKey = createChatSessionKey(session.provider, session.scope.key);
        codexProviderRuntime.runtimeState = 'busy';
        codexProviderRuntime.turnPhase = 'starting';
        codexProviderRuntime.activeTurnId = null;
        session.activeTurnId = null;
        session.turnPhase = 'starting';
        delete session.lastError;
        addMessage(session, {
            role: 'user',
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
        });
        publishState(session.scope, session);
        const response = await currentRuntime.client.requestDecoded('turn/start', {
            threadId: currentThreadId,
            input: [
                {
                    type: 'text',
                    text: modelText || ASSISTANT_IMAGE_ONLY_PROMPT,
                    text_elements: [],
                },
                ...attachments.map(attachment => ({
                    type: 'image',
                    url: attachment.dataUrl,
                })),
            ],
            ...(codexModel ? { model: codexModel } : {}),
            ...(codexServiceTier ? { serviceTier: codexServiceTier } : {}),
            cwd: currentRuntime.cwd,
            approvalPolicy: 'never',
            sandboxPolicy: {
                type: 'readOnly',
                networkAccess: false,
            },
            personality: 'friendly',
        }, decodeRecordResponse);
        if (isRecord(response.turn) && typeof response.turn.id === 'string') {
            session.model = normalizeCodexAssistantModel(codexAssistantModels, selection.model);
            if (session.threadId !== currentThreadId) {
                return {
                    ok: true,
                    state: currentState(session.scope, session),
                };
            }
            codexProviderRuntime.activeTurnId = response.turn.id;
            session.activeTurnId = response.turn.id;
            codexProviderRuntime.turnPhase = 'running';
            session.turnPhase = 'running';
        }
        publishState(session.scope, session);
        return {
            ok: true,
            state: currentState(session.scope, session),
        };
    } catch (error) {
        if (currentThreadId && session.threadId !== currentThreadId) {
            return withAssistantErrorEnvelope({
                ok: false,
                state: currentState(session.scope, session),
                error: getErrorMessage(error),
            });
        }
        codexProviderRuntime.lastError = getErrorMessage(error);
        session.lastError = codexProviderRuntime.lastError;
        codexProviderRuntime.runtimeState = 'error';
        codexProviderRuntime.turnPhase = 'error';
        session.activeTurnId = null;
        codexProviderRuntime.activeTurnId = null;
        session.turnPhase = 'error';
        addMessage(session, {
            role: 'system',
            text: codexProviderRuntime.lastError,
            error: codexProviderRuntime.lastError,
        });
        return withAssistantErrorEnvelope({
            ok: false,
            state: currentState(session.scope, session),
            error: codexProviderRuntime.lastError,
        });
    }
}

export async function interruptAgentAssistant(
    request?: IAgentAssistantScopedRequest,
): Promise<IAgentAssistantState> {
    const requestedSession = getRequestChatSession(request);
    const selection = resolveAssistantSelection(codexAssistantModels, request);
    const session = requestedSession ?? getActiveChatSession(selection.provider);
    if (session?.provider === 'claude') {
        if (session.claudeSession && session.activeTurnId) {
            claudeProviderRuntime.runtimeState = 'busy';
            claudeProviderRuntime.turnPhase = 'interrupting';
            session.turnPhase = 'interrupting';
            publishState(session.scope, session);
            await session.claudeSession.interrupt().catch((error: unknown) => {
                logger.warn(`Failed to interrupt Claude assistant turn: ${getErrorMessage(error)}`);
            });
            // interrupt() -> completeTurn() -> markClaudeTurnCompleted already resets
            // activeTurnId/turnPhase/runtimeState and emits the turn-completed event.
            return currentState(session.scope, session);
        }
        session.activeTurnId = null;
        session.turnPhase = 'idle';
        claudeProviderRuntime.activeTurnId = null;
        claudeProviderRuntime.turnPhase = 'idle';
        if (claudeProviderRuntime.runtimeState !== 'busy') {
            claudeProviderRuntime.runtimeState = 'ready';
        }
        publishState(session.scope, session);
        return currentState(session.scope, session);
    }

    if (runtime && session?.threadId && session.activeTurnId) {
        codexProviderRuntime.turnPhase = 'interrupting';
        session.turnPhase = 'interrupting';
        publishState(session.scope, session);
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
    codexProviderRuntime.activeTurnId = null;
    codexProviderRuntime.runtimeState = codexProviderRuntime.authState === 'signed-in' ? 'ready' : 'stopped';
    codexProviderRuntime.turnPhase = 'idle';
    publishState(session?.scope ?? null, session ?? selection);
    return currentState(session?.scope ?? null, session ?? selection);
}

export async function resetAgentAssistantChat(
    request?: IAgentAssistantScopedRequest,
): Promise<IAgentAssistantState> {
    const session = getRequestChatSession(request);
    const selection = resolveAssistantSelection(codexAssistantModels, request);
    if (!session) {
        return currentState(null, selection);
    }

    if (session.provider === 'claude') {
        if (session.claudeSession && session.activeTurnId) {
            claudeProviderRuntime.runtimeState = 'busy';
            claudeProviderRuntime.turnPhase = 'interrupting';
            session.turnPhase = 'interrupting';
            publishState(session.scope, session);
            await session.claudeSession.interrupt().catch((error: unknown) => {
                logger.warn(`Failed to interrupt Claude assistant turn during reset: ${getErrorMessage(error)}`);
            });
        }
        if (session.claudeSession) {
            await session.claudeSession.close().catch((error: unknown) => {
                logger.warn(`Failed to close reset Claude assistant session: ${getErrorMessage(error)}`);
            });
        }
        session.claudeSession = undefined;
        session.threadId = null;
        session.activeTurnId = null;
        session.turnPhase = 'idle';
        session.messages.length = 0;
        delete session.lastError;
        if (activeChatKey === createChatSessionKey(session.provider, session.scope.key)) {
            activeChatKey = null;
        }
        claudeProviderRuntime.activeTurnId = null;
        delete claudeProviderRuntime.lastError;
        claudeProviderRuntime.runtimeState = claudeInfoCache?.installed ? 'ready' : 'stopped';
        claudeProviderRuntime.turnPhase = 'idle';
        publishState(session.scope, session);
        return currentState(session.scope, session);
    }

    const previousThreadId = session.threadId;
    const previousTurnId = session.activeTurnId;
    if (runtime && previousThreadId && previousTurnId) {
        codexProviderRuntime.turnPhase = 'interrupting';
        session.turnPhase = 'interrupting';
        publishState(session.scope, session);
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
    if (activeChatKey === createChatSessionKey(session.provider, session.scope.key)) {
        activeChatKey = null;
    }
    codexProviderRuntime.activeTurnId = null;
    delete codexProviderRuntime.lastError;
    codexProviderRuntime.turnPhase = 'idle';
    codexProviderRuntime.runtimeState = codexProviderRuntime.authState === 'signed-in' ? 'ready' : 'stopped';
    publishState(session.scope, session);
    return currentState(session.scope, session);
}

export async function shutdownAgentAssistant() {
    await shutdownCodexAssistantRuntime({ shutdownMcp: false });
    await shutdownClaudeAssistantRuntime({ shutdownMcp: false });
    activeChatKey = null;
    await shutdownEmbeddedMcpServer();
}
