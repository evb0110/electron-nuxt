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
import {
    isCodexAppServerRequestTimeoutError,
    type ICodexAppServerNotification,
} from '@electron/features/agent/codexAppServerClient';
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
import {
    getAssistantTurnPhase,
    getAssistantTurnProviderTurnId,
    isAssistantTurnActive,
    matchesProviderTurn,
} from '@electron/features/agent/assistantTurnLifecycle';
import { getActiveAssistantMcpSessionScope } from '@electron/features/agent/assistantMcpSessionScope';
import { createAssistantSessionTurnCoordinator } from '@electron/features/agent/createAssistantSessionTurnCoordinator';
import { createAssistantAppServerNotificationController } from '@electron/features/agent/createAssistantAppServerNotificationController';
import { resolveAssistantPresetInstructions } from '@electron/features/agent/assistantPresetWorkflows';
import {
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

export interface IAgentAssistantSendMessageOptions { windowId?: number | null; }

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

const {
    claimSessionTurn,
    completeSessionTurn,
    errorSessionTurn,
    interruptSessionTurn,
    markSessionTurnRunning,
    rememberStateScope,
    supersedeSessionTurn,
    supersedeSessionTurnWithError,
} = createAssistantSessionTurnCoordinator({
    providerRuntimeStates,
    sessionStore,
});

const appServerNotifications = createAssistantAppServerNotificationController({
    addMessage,
    appendAssistantDelta,
    clearLoginState: () => {
        authReturnWindow = null;
        pendingLoginId = null;
    },
    clearRuntimeForExit: () => runtimeLifecycle.clearRuntimeForExit(),
    codexProviderRuntime,
    completeSessionTurn,
    currentCodexSelection,
    errorSessionTurn,
    getActiveChatSession: () => getActiveChatSession('codex'),
    getAuthReturnWindow: () => authReturnWindow,
    getChatSessionByThreadId,
    getRememberedScope: () => sessionStore.getRememberedScope(),
    logger,
    markSessionTurnRunning,
    noFocus: config.automation.noFocus,
    publishAssistantEvent,
    publishState,
    reconcileFailedTurnMessages,
    refreshAuthStateAndRuntimeAvailability,
    sessionStore,
    supersedeSessionTurn,
    upsertAssistantMessage,
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
        supersedeSessionTurn(session);
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

function getAssistantTurnBusyError() {
    return te('dialogs.agentAssistant.turnBusy');
}

function hasConflictingAssistantMcpSessionScope(session: IAssistantChatSession) {
    const activeScope = getActiveAssistantMcpSessionScope();
    return activeScope !== null && activeScope.sessionKey !== sessionStore.keyForSession(session);
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
    const sessionTurnPhase = session ? getAssistantTurnPhase(session.turnOwner) : fallbackTurnPhase;
    const sessionActiveTurnId = session
        ? getAssistantTurnProviderTurnId(session.turnOwner)
        : activeProviderRuntime.activeTurnId;
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

function handleAppServerNotification(notification: ICodexAppServerNotification) {
    appServerNotifications.handleNotification(notification);
}

function handleAppServerExit(message: string) {
    appServerNotifications.handleExit(message);
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

function requestBestEffortCodexTurnCleanup(
    currentRuntime: NonNullable<ReturnType<typeof runtimeLifecycle.getRuntime>>,
    threadId: string,
    turnId: string | null,
    reason: string,
) {
    if (turnId) {
        void currentRuntime.client.request('turn/interrupt', {
            threadId,
            turnId,
        }).catch((error: unknown) => {
            logger.warn(`Failed to interrupt ${reason} assistant turn: ${getErrorMessage(error)}`);
        });
    }
    void currentRuntime.client.request('thread/archive', { threadId }).catch((error: unknown) => {
        logger.warn(`Failed to archive ${reason} assistant thread: ${getErrorMessage(error)}`);
    });
}

function failCodexTurnAndFence(
    session: IAssistantChatSession,
    generation: number,
    reason: string,
    options: {
        currentRuntime: NonNullable<ReturnType<typeof runtimeLifecycle.getRuntime>>;
        threadId: string;
    },
) {
    const turnId = getAssistantTurnProviderTurnId(session.turnOwner);
    const ownsGeneration = session.turnOwner.generation === generation;
    if (ownsGeneration) {
        if (session.threadId === options.threadId) {
            session.threadId = null;
        }
        codexProviderRuntime.lastError = reason;
        codexProviderRuntime.runtimeState = 'error';
        session.lastError = reason;
        supersedeSessionTurnWithError(session, reason);
    }
    requestBestEffortCodexTurnCleanup(options.currentRuntime, options.threadId, turnId, 'timed-out');
    return ownsGeneration;
}

function markClaudeTurnCompleted(session: IAssistantChatSession, turnId: string | null) {
    if (turnId && !matchesProviderTurn(session.turnOwner, turnId)) {
        return;
    }

    if (!completeSessionTurn(session, session.turnOwner.generation, turnId)) {
        return;
    }
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
    errorSessionTurn(session, session.turnOwner.generation, message);
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

function shouldDropClaudeCallback(session: IAssistantChatSession, turnId: string | null) {
    return turnId === null || !matchesProviderTurn(session.turnOwner, turnId);
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
            markSessionTurnRunning(session, session.turnOwner.generation, turnId);
            claudeProviderRuntime.runtimeState = 'busy';
            publishAssistantEvent({
                type: 'turn-started',
                turnId,
            }, session.scope, session);
        },
        onAssistantDelta: (turnId: string | null, messageId: string, delta: string) => {
            if (shouldDropClaudeCallback(session, turnId)) {
                return;
            }
            if (claudeProviderRuntime.runtimeState === 'busy') {
                markSessionTurnRunning(session, session.turnOwner.generation, getAssistantTurnProviderTurnId(session.turnOwner));
                claudeProviderRuntime.turnPhase = 'running';
            }
            appendAssistantDelta(session, messageId, delta);
        },
        onAssistantMessage: (turnId: string | null, messageId: string, text: string, pending: boolean) => {
            if (shouldDropClaudeCallback(session, turnId)) {
                return;
            }
            upsertAssistantMessage(session, messageId, {
                text,
                pending,
            });
        },
        onTurnCompleted: (turnId: string | null) => {
            markClaudeTurnCompleted(session, turnId);
        },
        onError: (turnId: string | null, message: string) => {
            if (shouldDropClaudeCallback(session, turnId)) {
                return;
            }
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
        supersedeSessionTurn(session);
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
    options: IAgentAssistantSendMessageOptions = {},
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
    session.lastSenderWindowId = options.windowId ?? null;
    if (hasConflictingAssistantMcpSessionScope(session)) {
        const error = getAssistantTurnBusyError();
        return withAssistantErrorEnvelope({
            ok: false,
            state: currentState(session.scope, session),
            error,
        });
    }
    if (session.sendInFlight) {
        const error = getAssistantTurnBusyError();
        return withAssistantErrorEnvelope({
            ok: false,
            state: currentState(session.scope, session),
            error,
        });
    }

    const sendInFlight = Promise.resolve();
    session.sendInFlight = sendInFlight;
    try {

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
                claimSessionTurn(session);
                claudeProviderRuntime.runtimeState = 'busy';
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
        let turnGeneration: number | null = null;
        try {
            const currentRuntime = await ensureAssistantRuntime();
            const codexModel = getCodexAppServerModel(selection.model);
            const codexServiceTier = resolveCodexServiceTier(codexAssistantModels, selection.model, selection.speedMode);
            session.model = normalizeCodexAssistantModel(codexAssistantModels, selection.model);
            session.effort = selection.effort;
            session.speedMode = selection.speedMode;
            currentThreadId = await ensureAssistantThread(session);
            sessionStore.setActiveSession(session);
            turnGeneration = claimSessionTurn(session);
            codexProviderRuntime.runtimeState = 'busy';
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
                markSessionTurnRunning(session, turnGeneration, response.turn.id);
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
            const cleanupRuntime = runtimeLifecycle.getRuntime();
            if (
                isCodexAppServerRequestTimeoutError(error)
            && currentThreadId
            && turnGeneration !== null
            && cleanupRuntime
            ) {
                const fenced = failCodexTurnAndFence(session, turnGeneration, codexProviderRuntime.lastError, {
                    currentRuntime: cleanupRuntime,
                    threadId: currentThreadId,
                });
                if (fenced) {
                    reconcileFailedTurnMessages(session, codexProviderRuntime.lastError);
                    addMessage(session, {
                        role: 'system',
                        text: codexProviderRuntime.lastError,
                        error: codexProviderRuntime.lastError,
                    });
                }
                return withAssistantErrorEnvelope({
                    ok: false,
                    state: currentState(session.scope, session),
                    error: codexProviderRuntime.lastError,
                });
            }
            codexProviderRuntime.runtimeState = 'error';
            errorSessionTurn(
                session,
                turnGeneration ?? session.turnOwner.generation,
                codexProviderRuntime.lastError,
            );
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
    } finally {
        if (session.sendInFlight === sendInFlight) {
            session.sendInFlight = null;
        }
    }
}

export async function interruptAgentAssistant(
    request?: IAgentAssistantScopedRequest,
): Promise<IAgentAssistantState> {
    const requestedSession = getRequestChatSession(request);
    const selection = resolveAssistantSelection(codexAssistantModels, request);
    const session = requestedSession ?? getActiveChatSession(selection.provider);
    if (session?.provider === 'claude') {
        if (session.claudeSession && isAssistantTurnActive(session.turnOwner)) {
            claudeProviderRuntime.runtimeState = 'busy';
            interruptSessionTurn(session);
            publishState(session.scope, session);
            await session.claudeSession.interrupt().catch((error: unknown) => {
                logger.warn(`Failed to interrupt Claude assistant turn: ${getErrorMessage(error)}`);
            });
            // interrupt() -> completeTurn() -> markClaudeTurnCompleted already resets
            // activeTurnId/turnPhase/runtimeState and emits the turn-completed event.
            return currentState(session.scope, session);
        }
        supersedeSessionTurn(session);
        if (claudeProviderRuntime.runtimeState !== 'busy') {
            claudeProviderRuntime.runtimeState = 'ready';
        }
        publishState(session.scope, session);
        return currentState(session.scope, session);
    }

    const currentRuntime = runtimeLifecycle.getRuntime();
    const activeTurnId = session ? getAssistantTurnProviderTurnId(session.turnOwner) : null;
    if (currentRuntime && session?.threadId && activeTurnId) {
        interruptSessionTurn(session);
        publishState(session.scope, session);
        await currentRuntime.client.request('turn/interrupt', {
            threadId: session.threadId,
            turnId: activeTurnId,
        }).catch((error: unknown) => {
            logger.warn(`Failed to interrupt assistant turn: ${getErrorMessage(error)}`);
        });
    }
    if (session) {
        supersedeSessionTurn(session);
    }
    codexProviderRuntime.runtimeState = codexProviderRuntime.authState === 'signed-in' ? 'ready' : 'stopped';
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
        if (session.claudeSession && isAssistantTurnActive(session.turnOwner)) {
            claudeProviderRuntime.runtimeState = 'busy';
            interruptSessionTurn(session);
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
        supersedeSessionTurn(session);
        session.messages.length = 0;
        delete session.lastError;
        sessionStore.clearActiveSessionIfMatches(session);
        delete claudeProviderRuntime.lastError;
        claudeProviderRuntime.runtimeState = claudeInfoCache?.installed ? 'ready' : 'stopped';
        publishState(session.scope, session);
        return currentState(session.scope, session);
    }

    const previousThreadId = session.threadId;
    const previousTurnId = getAssistantTurnProviderTurnId(session.turnOwner);
    const currentRuntime = runtimeLifecycle.getRuntime();
    if (currentRuntime && previousThreadId && previousTurnId) {
        interruptSessionTurn(session);
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
    supersedeSessionTurn(session);
    session.messages.length = 0;
    delete session.lastError;
    sessionStore.clearActiveSessionIfMatches(session);
    delete codexProviderRuntime.lastError;
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
