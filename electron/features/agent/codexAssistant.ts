import * as electron from 'electron';
import { sanitizeAllowedExternalUrl } from '@contracts/externalUrl';
import { config } from '@electron/config';
import type {
    IAgentAssistantChatScope,
    IAgentAssistantEvent,
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
} from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';
import {
    ASSISTANT_DEFAULT_EFFORT,
    ASSISTANT_DEFAULT_SPEED_MODE,
    CODEX_ASSISTANT_FALLBACK_MODELS,
} from '@contracts/agentModels';
import {
    CODEX_APP_INSTALL_URL,
    CODEX_STANDALONE_INSTALL_URL,
    installManagedCodex,
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
    ASSISTANT_MCP_SERVER_NAME,
} from '@electron/features/agent/codexAssistantConfig';
import type { ICodexAppServerNotification } from '@electron/features/agent/codexAppServerClient';
import type { TCodexAssistantModelOption } from '@electron/features/agent/assistantModelCatalog';
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
import { normalizeClaudeAssistantAccount } from '@electron/features/agent/assistantProviderAccounts';
import {
    createAssistantErrorEnvelope,
    withAssistantErrorEnvelope,
} from '@electron/features/agent/assistantErrorEnvelope';
import { normalizeOutgoingMessageRequest } from '@electron/features/agent/assistantOutgoingMessage';
import {
    cloneAssistantScope,
    createAssistantChatSessionStore,
    normalizeAssistantScope,
    type IAssistantChatSession,
} from '@electron/features/agent/assistantChatSessionStore';
import {
    createAssistantRuntimeLifecycle,
    createBaseAssistantMcpStatus,
    ensureAssistantCwd,
} from '@electron/features/agent/assistantRuntimeLifecycle';
import { resolveAssistantPresetInstructions } from '@electron/features/agent/assistantPresetWorkflows';
import {
    focusAssistantReturnWindow,
    rememberAssistantReturnWindow,
    type TAssistantReturnWindow,
} from '@electron/features/agent/assistantReturnWindow';
import {
    shutdownEmbeddedMcpServer,
    startEmbeddedMcpServer,
} from '@electron/features/agent/mcpServer';
import { sendAgentAssistantEvent } from '@electron/features/agent/main/agentRendererEvents';
import { loadSettings } from '@electron/settings';
import { te } from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('agent-codex-assistant');

let codexAssistantModels: readonly TCodexAssistantModelOption[] = CODEX_ASSISTANT_FALLBACK_MODELS;
let claudeAssistantModels: readonly IAgentAssistantModelOption[] = CLAUDE_AGENT_MODELS;
const providerRuntimeStates = createAssistantProviderRuntimeStates();
const codexProviderRuntime = getAssistantProviderRuntimeState(providerRuntimeStates, 'codex');
const claudeProviderRuntime = getAssistantProviderRuntimeState(providerRuntimeStates, 'claude');

let claudeInfoCache: IClaudeAssistantProviderInfo | null = null;
let pendingLoginId: string | null = null;
let authReturnWindow: TAssistantReturnWindow = null;
let installPromise: Promise<IAgentAssistantInstallResult> | null = null;
const sessionStore = createAssistantChatSessionStore({
    onSessionDeleted: (session: IAssistantChatSession, reason: string) => {
        const currentRuntime = runtimeLifecycle.getRuntime();
        if (session.provider === 'codex' && currentRuntime && session.threadId) {
            void currentRuntime.client.request('thread/archive', { threadId: session.threadId }).catch((error: unknown) => {
                logger.warn(`Failed to archive ${reason} assistant thread: ${getErrorMessage(error)}`);
            });
        }
        if (session.provider === 'claude' && session.claudeSession) {
            void session.claudeSession.close().catch((error: unknown) => {
                logger.warn(`Failed to close ${reason} Claude assistant session: ${getErrorMessage(error)}`);
            });
        }
    },
    onSessionMessageEvent: (event: IAgentAssistantEvent, session: IAssistantChatSession) => {
        publishAssistantEvent(event, session.scope, session);
    },
});

const runtimeLifecycle = createAssistantRuntimeLifecycle({
    providerRuntime: codexProviderRuntime,
    sessionStore,
    getCodexModels: () => codexAssistantModels,
    setCodexModels: (models: readonly TCodexAssistantModelOption[]) => {
        codexAssistantModels = models;
    },
    isAssistantFeatureEnabled,
    createAssistantDisabledError,
    shutdownAssistant: () => shutdownAgentAssistant(),
    publishCodexState: (
        scope: IAgentAssistantChatScope | null | undefined,
        selection: IAssistantSelection | undefined,
    ) => publishState(
        scope === undefined ? sessionStore.getRememberedScope() : scope,
        selection ?? currentCodexSelection(),
    ),
    handleNotification: handleAppServerNotification,
    handleExit: handleAppServerExit,
    logger,
});

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
    await runtimeLifecycle.shutdownCodexRuntime(options);
}

async function shutdownClaudeAssistantRuntime(options: { shutdownMcp?: boolean } = {}) {
    const closePromises: Array<Promise<void>> = [];
    for (const session of sessionStore.listSessions()) {
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
    sessionStore.clearActiveSessionForProvider('claude');
    if (options.shutdownMcp === true) {
        await shutdownEmbeddedMcpServer();
    }
}

function rememberStateScope(
    scope: IAgentAssistantChatScope | null,
    selection: IAssistantSelection = sessionStore.getRememberedSelection(),
) {
    sessionStore.rememberStateScope(scope, selection);
}

function getChatSession(scope: IAgentAssistantChatScope, selection: IAssistantSelection, options: { create: true }): IAssistantChatSession;
function getChatSession(scope: IAgentAssistantChatScope | null, selection?: IAssistantSelection, options?: { create?: false }): IAssistantChatSession | null;
function getChatSession(
    scope: IAgentAssistantChatScope | null,
    selection: IAssistantSelection = sessionStore.getRememberedSelection(),
    options: { create?: boolean } = {},
) {
    if (options.create === true) {
        if (!scope) {
            throw new Error('Cannot create assistant chat session without a scope.');
        }
        return sessionStore.getSession(scope, selection, { create: true });
    }
    return sessionStore.getSession(scope, selection);
}

function getActiveChatSession(provider?: TAgentAssistantProviderId) {
    return sessionStore.getActiveSession(provider);
}

function getChatSessionByThreadId(candidateThreadId: string | null) {
    return sessionStore.getSessionByThreadId(candidateThreadId);
}

function getRequestChatSession(request?: IAgentAssistantStateRequest | IAgentAssistantScopedRequest | null) {
    const scope = sessionStore.resolveRequestedScope(request);
    const selection = resolveAssistantSelection(codexAssistantModels, request);
    rememberStateScope(scope, selection);
    return scope ? getChatSession(scope, selection, { create: true }) : null;
}

function createBaseMcpStatus() {
    return createBaseAssistantMcpStatus();
}

function decodeRecordResponse(value: unknown): Record<PropertyKey, unknown> | null {
    return isRecord(value) ? value : null;
}

function getCodexAppServerModel(model: string | null | undefined) {
    return normalizeCodexAssistantModel(codexAssistantModels, model);
}

function currentCodexSelection(): IAssistantSelection {
    const selection = sessionStore.getRememberedSelection();
    const model = selection.provider === 'codex' ? selection.model : codexDefaultModelId(codexAssistantModels);
    return {
        provider: 'codex',
        model,
        effort: normalizeAssistantEffort(
            codexAssistantModels,
            'codex',
            model,
            selection.provider === 'codex' ? selection.effort : ASSISTANT_DEFAULT_EFFORT,
        ),
        speedMode: normalizeAssistantSpeedMode(
            codexAssistantModels,
            'codex',
            model,
            selection.provider === 'codex' ? selection.speedMode : ASSISTANT_DEFAULT_SPEED_MODE,
        ),
    };
}

function getSessionForStatus(scope: IAgentAssistantChatScope | null, selection: IAssistantSelection) {
    return getChatSession(scope, selection);
}

function currentStatus(
    scope: IAgentAssistantChatScope | null = sessionStore.getRememberedScope(),
    selection: IAssistantSelection = sessionStore.getRememberedSelection(),
): IAgentAssistantStatus {
    const codexInfo = runtimeLifecycle.getCodexInfo();
    const installed = codexInfo?.installed === true;
    const versionSupported = codexInfo?.isVersionSupported === true;
    const supported = process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux';
    const normalizedModel = normalizeAssistantModel(codexAssistantModels, selection.provider, selection.model);
    const normalizedSelection = {
        provider: selection.provider,
        model: normalizedModel,
        effort: normalizeAssistantEffort(codexAssistantModels, selection.provider, normalizedModel, selection.effort),
        speedMode: normalizeAssistantSpeedMode(codexAssistantModels, selection.provider, normalizedModel, selection.speedMode),
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
    const fallbackProvider = providerStatuses[0];
    if (!fallbackProvider) {
        throw new Error('No assistant providers are available.');
    }
    const activeProvider = providerStatuses.find((
        provider: IAgentAssistantStatus['providers'][number],
    ) => provider.id === normalizedSelection.provider) ?? fallbackProvider;
    const model = normalizeAssistantModel(
        codexAssistantModels,
        normalizedSelection.provider,
        session?.model ?? normalizedSelection.model,
    );
    const models = activeProvider.models;
    const effort = normalizeAssistantEffort(codexAssistantModels, normalizedSelection.provider, model, effortInput);
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
        availableEfforts: getProviderEfforts(codexAssistantModels, normalizedSelection.provider, model),
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

function cloneMessages(
    scope: IAgentAssistantChatScope | null = sessionStore.getRememberedScope(),
    selection: IAssistantSelection = sessionStore.getRememberedSelection(),
) {
    return sessionStore.getMessages(scope, selection);
}

function currentState(
    scope: IAgentAssistantChatScope | null = sessionStore.getRememberedScope(),
    selection: IAssistantSelection = sessionStore.getRememberedSelection(),
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
    scope: IAgentAssistantChatScope | null = sessionStore.getRememberedScope(),
    selection: IAssistantSelection = sessionStore.getRememberedSelection(),
) {
    const normalizedEvent = withAssistantErrorEnvelope(event);
    const payload = {
        ...normalizedEvent,
        ...(shouldAttachStateToAssistantEvent(normalizedEvent)
            ? { state: normalizedEvent.state ?? currentState(scope, selection) }
            : {}),
    } satisfies IAgentAssistantEvent;
    for (const window of electron.BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) {
            continue;
        }
        sendAgentAssistantEvent(window, payload);
    }
}

function publishState(
    scope: IAgentAssistantChatScope | null = sessionStore.getRememberedScope(),
    selection: IAssistantSelection = sessionStore.getRememberedSelection(),
) {
    publishAssistantEvent({
        type: 'state',
        state: currentState(scope, selection),
    }, scope, selection);
}

function addMessage(
    session: IAssistantChatSession,
    message: Parameters<typeof sessionStore.addMessage>[1],
) {
    return sessionStore.addMessage(session, message);
}

function upsertAssistantMessage(
    session: IAssistantChatSession,
    id: string,
    patch: Parameters<typeof sessionStore.upsertAssistantMessage>[2],
) {
    return sessionStore.upsertAssistantMessage(session, id, patch);
}

function appendAssistantDelta(session: IAssistantChatSession, messageId: string, delta: string) {
    sessionStore.appendAssistantDelta(session, messageId, delta);
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
            focusAssistantReturnWindow(authReturnWindow, { noFocus: config.automation.noFocus });
        }
        authReturnWindow = null;
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
        sessionStore.setActiveSession(session);
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
        }, session?.scope ?? sessionStore.getRememberedScope(), session ?? currentCodexSelection());
    }
}

function handleAppServerExit(message: string) {
    const session = getActiveChatSession('codex');
    runtimeLifecycle.clearRuntimeForExit();
    codexProviderRuntime.runtimeState = 'error';
    codexProviderRuntime.turnPhase = 'error';
    codexProviderRuntime.activeTurnId = null;
    for (const chatSession of sessionStore.listSessions()) {
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
    }, session?.scope ?? sessionStore.getRememberedScope(), session ?? currentCodexSelection());
}

async function refreshCodexInfo() {
    return runtimeLifecycle.refreshCodexInfo();
}

function hasActiveClaudeSession() {
    for (const session of sessionStore.listSessions()) {
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
    await runtimeLifecycle.refreshAuthState();
}

async function refreshAuthStateAndRuntimeAvailability(options: { recoverFromError?: boolean } = {}) {
    await runtimeLifecycle.refreshAuthStateAndRuntimeAvailability(options);
}

async function ensureAssistantRuntime() {
    return runtimeLifecycle.ensureRuntime();
}

let claudeMcpToolCount = 0;

function createBaseMcpStatusWithToolCount(
    provider: TAgentAssistantProviderId = sessionStore.getRememberedSelection().provider,
): IAgentAssistantStatus['mcp'] {
    const base = createBaseMcpStatus();
    return {
        ...base,
        toolCount: provider === 'claude' ? claudeMcpToolCount : runtimeLifecycle.getMcpToolCount(),
    };
}

async function ensureAssistantThread(session: IAssistantChatSession) {
    return runtimeLifecycle.ensureThread(session);
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
    session.messages = session.messages.filter(message => {
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
            sessionStore.setActiveSession(session);
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
    const normalizedEffort = normalizeAssistantEffort(codexAssistantModels, 'claude', normalizedModel, effort);
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
    const cwd = await ensureAssistantCwd();
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
        const codexInfo = await refreshCodexInfo();
        if (codexInfo.installed && codexInfo.isVersionSupported) {
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
            const codexInfo = await installManagedCodex({onProgress: (progress: string) => publishAssistantEvent({
                type: 'install-progress',
                progress,
            })});
            runtimeLifecycle.setCodexInfo(codexInfo);
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
    parentWindow?: electron.BrowserWindow | null,
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
        authReturnWindow = rememberAssistantReturnWindow(parentWindow);
        const authUrl = typeof response.authUrl === 'string' ? response.authUrl : undefined;
        const verificationUrl = typeof response.verificationUrl === 'string' ? response.verificationUrl : undefined;
        const urlToOpen = authUrl ?? verificationUrl;
        if (urlToOpen) {
            await electron.shell.openExternal(sanitizeAllowedExternalUrl(urlToOpen));
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
    const currentRuntime = runtimeLifecycle.getRuntime();
    if (currentRuntime && pendingLoginId) {
        await currentRuntime.client.request('account/login/cancel', { loginId: pendingLoginId }).catch((error: unknown) => {
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
            sessionStore.setActiveSession(session);
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
        const currentRuntime = await ensureAssistantRuntime();
        const codexModel = getCodexAppServerModel(selection.model);
        const codexServiceTier = resolveCodexServiceTier(codexAssistantModels, selection.model, selection.speedMode);
        session.model = normalizeCodexAssistantModel(codexAssistantModels, selection.model);
        session.effort = selection.effort;
        session.speedMode = selection.speedMode;
        currentThreadId = await ensureAssistantThread(session);
        sessionStore.setActiveSession(session);
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
                ...attachments.map((attachment: NonNullable<IAgentAssistantSendMessageRequest['attachments']>[number]) => ({
                    type: 'image',
                    url: attachment.dataUrl,
                })),
            ],
            ...(codexModel ? { model: codexModel } : {}),
            effort: selection.effort,
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

    const currentRuntime = runtimeLifecycle.getRuntime();
    if (currentRuntime && session?.threadId && session.activeTurnId) {
        codexProviderRuntime.turnPhase = 'interrupting';
        session.turnPhase = 'interrupting';
        publishState(session.scope, session);
        await currentRuntime.client.request('turn/interrupt', {
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
        sessionStore.clearActiveSessionIfMatches(session);
        claudeProviderRuntime.activeTurnId = null;
        delete claudeProviderRuntime.lastError;
        claudeProviderRuntime.runtimeState = claudeInfoCache?.installed ? 'ready' : 'stopped';
        claudeProviderRuntime.turnPhase = 'idle';
        publishState(session.scope, session);
        return currentState(session.scope, session);
    }

    const previousThreadId = session.threadId;
    const previousTurnId = session.activeTurnId;
    const currentRuntime = runtimeLifecycle.getRuntime();
    if (currentRuntime && previousThreadId && previousTurnId) {
        codexProviderRuntime.turnPhase = 'interrupting';
        session.turnPhase = 'interrupting';
        publishState(session.scope, session);
        await currentRuntime.client.request('turn/interrupt', {
            threadId: previousThreadId,
            turnId: previousTurnId,
        }).catch((error: unknown) => {
            logger.warn(`Failed to interrupt assistant turn during reset: ${getErrorMessage(error)}`);
        });
    }

    if (currentRuntime && previousThreadId) {
        void currentRuntime.client.request('thread/archive', { threadId: previousThreadId }).catch((error: unknown) => {
            logger.warn(`Failed to archive reset assistant thread: ${getErrorMessage(error)}`);
        });
    }

    session.threadId = null;
    session.activeTurnId = null;
    session.turnPhase = 'idle';
    session.messages.length = 0;
    delete session.lastError;
    sessionStore.clearActiveSessionIfMatches(session);
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
    sessionStore.clearActiveSession();
    await shutdownEmbeddedMcpServer();
}
