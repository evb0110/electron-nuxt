import {
    shell,
    type BrowserWindow,
} from 'electron';
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
import { buildAgentAssistantScopeFingerprint } from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';
import {
    ASSISTANT_DEFAULT_EFFORT,
    ASSISTANT_DEFAULT_SPEED_MODE,
    CODEX_ASSISTANT_FALLBACK_MODELS,
} from '@contracts/agentModels';
import { installManagedCodex } from '@electron/features/agent/codexCli';
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
import { createClaudeTurnPresentationCallbacks } from '@electron/features/agent/createClaudeTurnPresentationCallbacks';
import {
    ASSISTANT_IMAGE_ONLY_PROMPT,
    ASSISTANT_MCP_SERVER_NAME,
} from '@electron/features/agent/codexAssistantConfig';
import {isCodexAppServerRequestTimeoutError} from '@electron/features/agent/codexAppServerClient';
import type { TCodexAssistantModelOption } from '@electron/features/agent/assistantModelCatalog';
import {
    codexDefaultModelId,
    normalizeAssistantEffort,
    normalizeAssistantSpeedMode,
    normalizeCodexAssistantModel,
    resolveAssistantSelection,
    resolveCodexServiceTier,
    type IAssistantSelection,
    type IClaudeAssistantProviderInfo,
} from '@electron/features/agent/assistantProviderStatus';
import {
    createAssistantProviderRuntimeStates,
    getAssistantProviderRuntimeState,
} from '@electron/features/agent/assistantProviderState';
import { normalizeClaudeAssistantAccount } from '@electron/features/agent/assistantProviderAccounts';
import { withAssistantErrorEnvelope } from '@electron/features/agent/assistantErrorEnvelope';
import { normalizeOutgoingMessageRequest } from '@electron/features/agent/assistantOutgoingMessage';
import {
    createAssistantChatSessionStore,
    normalizeAssistantScope,
    type IAssistantChatSession,
} from '@electron/features/agent/assistantChatSessionStore';
import {
    createAssistantFeatureLifecycle,
    createAssistantRuntimeLifecycle,
    createBaseAssistantMcpStatus,
    ensureAssistantCwd,
} from '@electron/features/agent/assistantRuntimeLifecycle';
import {
    buildAssistantSessionScopeBindingFingerprint,
    getAssistantTurnProviderTurnId,
    getAssistantTurnScope,
    isAssistantTurnActive,
    matchesProviderTurn,
} from '@electron/features/agent/assistantTurnLifecycle';
import { getActiveAssistantMcpSessionScope } from '@electron/features/agent/assistantMcpSessionScope';
import { buildAgentAssistantStateSnapshot } from '@electron/features/agent/buildAgentAssistantStateSnapshot';
import { createAssistantSessionTurnCoordinator } from '@electron/features/agent/createAssistantSessionTurnCoordinator';
import {
    createAssistantHeartbeatController,
    waitForBoundedAssistantInterrupt,
} from '@electron/features/agent/assistantTurnLiveness';
import { createAssistantAppServerNotificationController } from '@electron/features/agent/createAssistantAppServerNotificationController';
import { createAssistantEventPublisher } from '@electron/features/agent/createAssistantEventPublisher';
import { resolveAssistantPresetInstructions } from '@electron/features/agent/assistantPresetWorkflows';
import {
    rememberAssistantReturnWindow,
    type TAssistantReturnWindow,
} from '@electron/features/agent/assistantReturnWindow';
import {
    abortActiveEmbeddedMcpRequests,
    shutdownEmbeddedMcpServer,
    startEmbeddedMcpServer,
} from '@electron/features/agent/mcpServer';
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
        if (session.provider === 'codex' && currentRuntime && session.providerThreadId) {
            void currentRuntime.client.request('thread/archive', { threadId: session.providerThreadId }).catch((error: unknown) => {
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
    handleNotification: notification => appServerNotifications.handleNotification(notification),
    handleExit: message => appServerNotifications.handleExit(message),
    logger,
});
const assistantFeatureLifecycle = createAssistantFeatureLifecycle({
    isEnabled: isAssistantFeatureEnabled,
    createDisabledError: createAssistantDisabledError,
});
let syncAssistantHeartbeat = () => {};
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
    sessionStore,
    onTurnStateChanged: () => syncAssistantHeartbeat(),
});
async function isAssistantFeatureEnabled() {
    const settings = await loadSettings();
    return settings.assistantPanelEnabled;
}

function createAssistantDisabledError() {
    return te('dialogs.agentAssistant.disabledMessage');
}

function createAssistantDisabledResult(state: IAgentAssistantState) {
    const error = createAssistantDisabledError();
    return withAssistantErrorEnvelope({
        ok: false,
        state,
        error,
    });
}

async function stopAssistantForDisabledFeature() {
    await shutdownAgentAssistant();
    const error = createAssistantDisabledError();
    codexProviderRuntime.lastError = error;
    codexProviderRuntime.runtimeState = 'stopped';
    return error;
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
        session.providerThreadId = null;
        supersedeSessionTurn(session);
    }
    await Promise.allSettled(closePromises);
    claudeProviderRuntime.runtimeState = 'stopped';
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

function getAssistantTurnBusyError() {
    return te('dialogs.agentAssistant.turnBusy');
}

function createAssistantBusyResult(session: IAssistantChatSession) {
    const error = getAssistantTurnBusyError();
    return withAssistantErrorEnvelope({
        ok: false,
        state: currentState(session.scope, session),
        error,
    });
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

function decodeRecordResponse(value: unknown): Record<PropertyKey, unknown> | null {
    return isRecord(value) ? value : null;
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
    return buildAgentAssistantStateSnapshot({
        claudeInfo: claudeInfoCache,
        claudeModels: claudeAssistantModels,
        codexInfo: runtimeLifecycle.getCodexInfo(),
        codexModels: codexAssistantModels,
        createMcpStatus: createBaseMcpStatusWithToolCount,
        getSessionForStatus: (requestedScope, requestedSelection) =>
            getChatSession(requestedScope, requestedSelection),
        isAssistantTurnActiveForScope,
        messages: cloneMessages(scope, selection),
        platform: process.platform,
        providerRuntimeStates,
        scope,
        selection,
    });
}

const {
    publishAssistantEvent,
    publishState,
} = createAssistantEventPublisher({
    currentState,
    getDefaultScope: sessionStore.getRememberedScope,
    getDefaultSelection: sessionStore.getRememberedSelection,
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
    getActiveChatSession: () => sessionStore.getActiveSession('codex'),
    getAuthReturnWindow: () => authReturnWindow,
    getChatSessionByThreadId: candidateThreadId => sessionStore.getSessionByThreadId(candidateThreadId),
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

function startAssistantHeartbeat() {
    const heartbeat = createAssistantHeartbeatController({
        sessions: sessionStore.listSessions,
        isActive: session => isAssistantTurnActive(session.turnOwner),
        recordBoundary: sessionStore.recordTurnBoundary,
        publish: (event, session) => publishAssistantEvent(event, session.scope, session),
    });
    syncAssistantHeartbeat = heartbeat.sync;
    return heartbeat;
}

type TAssistantHeartbeatTimer =
    ReturnType<typeof startAssistantHeartbeat>;

let assistantHeartbeatTimer: TAssistantHeartbeatTimer | null = null;

export function initializeAgentAssistantRuntime() {
    assistantHeartbeatTimer ??= startAssistantHeartbeat();
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
        claudeProviderRuntime.account = null;
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

let claudeMcpToolCount = 0;

function createBaseMcpStatusWithToolCount(
    provider: TAgentAssistantProviderId = sessionStore.getRememberedSelection().provider,
): IAgentAssistantStatus['mcp'] {
    const base = createBaseAssistantMcpStatus();
    return {
        ...base,
        toolCount: provider === 'claude' ? claudeMcpToolCount : runtimeLifecycle.getMcpToolCount(),
    };
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

async function interruptStaleSessionTurn(
    session: IAssistantChatSession,
    reason: string,
) {
    if (session.provider === 'claude') {
        if (!session.claudeSession || !isAssistantTurnActive(session.turnOwner)) {
            return;
        }
        await session.claudeSession.interrupt().catch((error: unknown) => {
            logger.warn(`Failed to interrupt ${reason} Claude assistant turn: ${getErrorMessage(error)}`);
        });
        return;
    }

    const currentRuntime = runtimeLifecycle.getRuntime();
    const activeTurnId = getAssistantTurnProviderTurnId(session.turnOwner);
    if (!currentRuntime || !session.providerThreadId || !activeTurnId) {
        return;
    }

    await currentRuntime.client.request('turn/interrupt', {
        threadId: session.providerThreadId,
        turnId: activeTurnId,
    }).catch((error: unknown) => {
        logger.warn(`Failed to interrupt ${reason} assistant turn: ${getErrorMessage(error)}`);
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
        if (session.providerThreadId === options.threadId) {
            session.providerThreadId = null;
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
    sessionStore.recordSessionSnapshot(session);
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

function isActiveTurnScopeCurrent(session: IAssistantChatSession) {
    const turnScope = getAssistantTurnScope(session.turnOwner);
    return !turnScope
        || buildAssistantSessionScopeBindingFingerprint(turnScope)
            === buildAgentAssistantScopeFingerprint(session.provider, session.scope);
}

function isAssistantTurnActiveForScope(
    session: IAssistantChatSession,
    scope: IAgentAssistantChatScope | null,
) {
    const turnScope = getAssistantTurnScope(session.turnOwner);
    return Boolean(turnScope)
        && buildAssistantSessionScopeBindingFingerprint(turnScope)
            === buildAgentAssistantScopeFingerprint(session.provider, scope ?? session.scope);
}

function shouldDropClaudeCallback(session: IAssistantChatSession, turnId: string | null) {
    return turnId === null
        || !matchesProviderTurn(session.turnOwner, turnId)
        || !isActiveTurnScopeCurrent(session);
}
function createClaudeCallbacks(session: IAssistantChatSession) {
    const presentationCallbacks = createClaudeTurnPresentationCallbacks({
        session,
        shouldDrop: turnId => shouldDropClaudeCallback(session, turnId),
        publish: event => publishAssistantEvent(event, session.scope, session),
    });
    return {
        onInitialized: (info: IClaudeAgentAssistantInit) => {
            session.providerThreadId = info.sessionId;
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
            }
            sessionStore.recordSessionSnapshot(session);
            publishState(session.scope, session);
        },
        onTurnStarted: (turnId: string) => {
            if (!isActiveTurnScopeCurrent(session)) {
                return;
            }
            sessionStore.setActiveSession(session);
            markSessionTurnRunning(session, session.turnOwner.generation, turnId);
            claudeProviderRuntime.runtimeState = 'busy';
            session.turnPresentation.phase = 'thinking';
            session.turnPresentation.lastEventAtMs = Date.now();
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
            }
            session.turnPresentation.phase = 'streaming';
            session.turnPresentation.lastEventAtMs = Date.now();
            appendAssistantDelta(session, messageId, delta);
        },
        onReasoningDelta: (turnId: string | null, delta: string) => {
            if (shouldDropClaudeCallback(session, turnId)) {
                return;
            }
            session.turnPresentation.phase = 'thinking';
            session.turnPresentation.reasoning += delta;
            session.turnPresentation.lastEventAtMs = Date.now();
            publishAssistantEvent({
                type: 'reasoning-delta',
                reasoningDelta: delta,
                phase: 'thinking',
                lastEventAtMs: session.turnPresentation.lastEventAtMs,
            }, session.scope, session);
        },
        ...presentationCallbacks,
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
    generation: number,
) {
    await assistantFeatureLifecycle.assertEnabled(generation);
    const claudeInfo = await refreshClaudeInfo();
    await assistantFeatureLifecycle.assertEnabled(generation);
    if (!claudeInfo.installed || !claudeInfo.executablePath) {
        const error = claudeInfo.error ?? 'Claude Agent SDK is not available.';
        claudeProviderRuntime.lastError = error;
        claudeProviderRuntime.runtimeState = 'stopped';
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
            sessionStore.recordSessionSnapshot(session);
            return session.claudeSession;
        }
        await session.claudeSession.close().catch((error: unknown) => {
            logger.warn(`Failed to close Claude assistant session for settings change: ${getErrorMessage(error)}`);
        });
        session.claudeSession = undefined;
        session.providerThreadId = null;
        supersedeSessionTurn(session);
    }
    claudeProviderRuntime.runtimeState = 'starting';
    delete claudeProviderRuntime.lastError;
    publishState(session.scope, session);
    const cwd = await ensureAssistantCwd();
    await assistantFeatureLifecycle.assertEnabled(generation);
    const {
        descriptor,
        token: mcpToken,
    } = await startEmbeddedMcpServer();
    await assistantFeatureLifecycle.assertEnabled(generation);
    session.model = normalizedModel;
    session.effort = normalizedEffort;
    session.speedMode = normalizedSpeedMode;
    sessionStore.recordSessionSnapshot(session);
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
    publishState(session.scope, session);
    return session.claudeSession;
}
export async function getAgentAssistantState(
    request?: IAgentAssistantStateRequest,
): Promise<IAgentAssistantState> {
    await assistantFeatureLifecycle.waitForShutdown();
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
        const codexInfo = await runtimeLifecycle.refreshCodexInfo();
        if (codexInfo.installed && codexInfo.isVersionSupported) {
            try {
                await runtimeLifecycle.ensureRuntime();
                await refreshAuthStateAndRuntimeAvailability();
            } catch (error) {
                logger.warn(`Assistant runtime is not ready: ${getErrorMessage(error)}`);
            }
        }
    }
    return currentState(scope, selection);
}

export async function installAgentAssistantCodex(): Promise<IAgentAssistantInstallResult> {
    await assistantFeatureLifecycle.waitForShutdown();
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
                progress: 'Starting EVB Assistant with the updated Codex.',
            });
            await runtimeLifecycle.ensureRuntime();
            return {
                ok: true,
                state: currentState(),
            };
        } catch (error) {
            codexProviderRuntime.lastError = getErrorMessage(error);
            codexProviderRuntime.runtimeState = 'error';
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
    await assistantFeatureLifecycle.waitForShutdown();
    const operationGeneration = assistantFeatureLifecycle.captureGeneration();
    try {
        const currentRuntime = await runtimeLifecycle.ensureRuntime();
        await assistantFeatureLifecycle.assertEnabled(operationGeneration);
        await runtimeLifecycle.assertRuntimeEnabled(currentRuntime);
        const params = request.mode === 'device-code'
            ? { type: 'chatgptDeviceCode' }
            : {
                type: 'chatgpt',
                codexStreamlinedLogin: true,
            };
        const response = await currentRuntime.client.requestDecoded('account/login/start', params, decodeRecordResponse);
        await assistantFeatureLifecycle.assertEnabled(operationGeneration);
        await runtimeLifecycle.assertRuntimeEnabled(currentRuntime);
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
            await shell.openExternal(sanitizeAllowedExternalUrl(urlToOpen));
            await assistantFeatureLifecycle.assertEnabled(operationGeneration);
            await runtimeLifecycle.assertRuntimeEnabled(currentRuntime);
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
        if (!(await assistantFeatureLifecycle.isEnabled(operationGeneration))) {
            return createAssistantDisabledResult(currentState());
        }
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
    await assistantFeatureLifecycle.waitForShutdown();
    if (!(await isAssistantFeatureEnabled())) {
        const error = await stopAssistantForDisabledFeature();
        return withAssistantErrorEnvelope({
            ok: false,
            state: currentState(),
            error,
        });
    }
    const operationGeneration = assistantFeatureLifecycle.captureGeneration();

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
        return createAssistantBusyResult(session);
    }
    if (session.sendInFlight) {
        return createAssistantBusyResult(session);
    }
    if (isAssistantTurnActive(session.turnOwner)) {
        if (!isAssistantTurnActiveForScope(session, session.scope)) {
            interruptSessionTurn(session);
            publishState(session.scope, session);
            await interruptStaleSessionTurn(session, 'stale-scope');
        }
        return createAssistantBusyResult(session);
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
                    operationGeneration,
                );
                await assistantFeatureLifecycle.assertEnabled(operationGeneration);
                if (session.claudeSession !== claudeSession) {
                    return createAssistantBusyResult(session);
                }
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
                await assistantFeatureLifecycle.assertEnabled(operationGeneration);
                if (session.claudeSession !== claudeSession) {
                    return createAssistantBusyResult(session);
                }
                publishState(session.scope, session);
                return {
                    ok: true,
                    state: currentState(session.scope, session),
                };
            } catch (error) {
                if (!(await assistantFeatureLifecycle.isEnabled(operationGeneration))) {
                    return createAssistantDisabledResult(currentState(session.scope, session));
                }
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
            const currentRuntime = await runtimeLifecycle.ensureRuntime();
            await assistantFeatureLifecycle.assertEnabled(operationGeneration);
            await runtimeLifecycle.assertRuntimeEnabled(currentRuntime);
            const codexModel = normalizeCodexAssistantModel(codexAssistantModels, selection.model);
            const codexServiceTier = resolveCodexServiceTier(codexAssistantModels, selection.model, selection.speedMode);
            session.model = normalizeCodexAssistantModel(codexAssistantModels, selection.model);
            session.effort = selection.effort;
            session.speedMode = selection.speedMode;
            currentThreadId = await runtimeLifecycle.ensureThread(session);
            await assistantFeatureLifecycle.assertEnabled(operationGeneration);
            await runtimeLifecycle.assertRuntimeEnabled(currentRuntime);
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
            await assistantFeatureLifecycle.assertEnabled(operationGeneration);
            await runtimeLifecycle.assertRuntimeEnabled(currentRuntime);
            if (isRecord(response.turn) && typeof response.turn.id === 'string') {
                session.model = normalizeCodexAssistantModel(codexAssistantModels, selection.model);
                if (session.providerThreadId !== currentThreadId) {
                    return {
                        ok: true,
                        state: currentState(session.scope, session),
                    };
                }
                if (!isActiveTurnScopeCurrent(session)) {
                    interruptSessionTurn(session);
                    publishState(session.scope, session);
                    await interruptStaleSessionTurn(session, 'stale-scope');
                    return withAssistantErrorEnvelope({
                        ok: false,
                        state: currentState(session.scope, session),
                        error: getAssistantTurnBusyError(),
                    });
                }
                markSessionTurnRunning(session, turnGeneration, response.turn.id);
            }
            publishState(session.scope, session);
            return {
                ok: true,
                state: currentState(session.scope, session),
            };
        } catch (error) {
            if (!(await assistantFeatureLifecycle.isEnabled(operationGeneration))) {
                return createAssistantDisabledResult(currentState(session.scope, session));
            }
            if (currentThreadId && session.providerThreadId !== currentThreadId) {
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
    const session = requestedSession ?? sessionStore.getActiveSession(selection.provider);
    abortActiveEmbeddedMcpRequests(session?.scopeBinding ?? null, 'Assistant turn interrupted by the user.');
    if (session?.provider === 'claude') {
        if (session.claudeSession && isAssistantTurnActive(session.turnOwner)) {
            claudeProviderRuntime.runtimeState = 'busy';
            interruptSessionTurn(session);
            publishState(session.scope, session);
            await waitForBoundedAssistantInterrupt(session.claudeSession.interrupt()).catch((error: unknown) => {
                logger.warn(`Failed to interrupt Claude assistant turn: ${getErrorMessage(error)}`);
                session.turnPresentation.phase = 'stalled';
                session.turnPresentation.lastEventAtMs = Date.now();
            });
            // interrupt() -> completeTurn() -> markClaudeTurnCompleted already resets
            // runtimeState and emits the turn-completed event.
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
    let codexInterruptRequested = false;
    if (currentRuntime && session?.providerThreadId && activeTurnId) {
        codexInterruptRequested = true;
        interruptSessionTurn(session);
        codexProviderRuntime.runtimeState = 'busy';
        publishState(session.scope, session);
        try {
            await waitForBoundedAssistantInterrupt(currentRuntime.client.request('turn/interrupt', {
                threadId: session.providerThreadId,
                turnId: activeTurnId,
            }));
        } catch (error) {
            const message = getErrorMessage(error);
            logger.warn(`Failed to interrupt assistant turn: ${message}`);
            codexProviderRuntime.lastError = message;
            session.lastError = message;
            session.turnPresentation.phase = 'stalled';
            session.turnPresentation.lastEventAtMs = Date.now();
        }
    }
    if (session && codexInterruptRequested) {
        codexProviderRuntime.runtimeState = 'busy';
        publishState(session.scope, session);
        return currentState(session.scope, session);
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
        session.providerThreadId = null;
        supersedeSessionTurn(session);
        session.messages.length = 0;
        delete session.lastError;
        sessionStore.clearActiveSessionIfMatches(session);
        sessionStore.resetSessionTranscript(session, 'reset');
        delete claudeProviderRuntime.lastError;
        claudeProviderRuntime.runtimeState = claudeInfoCache?.installed ? 'ready' : 'stopped';
        publishState(session.scope, session);
        return currentState(session.scope, session);
    }

    const previousThreadId = session.providerThreadId;
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

    session.providerThreadId = null;
    supersedeSessionTurn(session);
    session.messages.length = 0;
    delete session.lastError;
    sessionStore.clearActiveSessionIfMatches(session);
    sessionStore.resetSessionTranscript(session, 'reset');
    delete codexProviderRuntime.lastError;
    codexProviderRuntime.runtimeState = codexProviderRuntime.authState === 'signed-in' ? 'ready' : 'stopped';
    publishState(session.scope, session);
    return currentState(session.scope, session);
}

async function runAssistantShutdownStep(label: string, run: () => unknown | Promise<unknown>) {
    try {
        await run();
    } catch (error) {
        logger.warn(`Failed to shut down ${label}: ${getErrorMessage(error)}`);
    }
}

export function shutdownAgentAssistant() {
    return assistantFeatureLifecycle.shutdown(async () => {
        assistantHeartbeatTimer?.dispose();
        assistantHeartbeatTimer = null;
        syncAssistantHeartbeat = () => {};
        authReturnWindow = null;
        pendingLoginId = null;
        await runAssistantShutdownStep('Codex runtime', () => runtimeLifecycle.shutdownCodexRuntime({shutdownMcp: false}));
        await runAssistantShutdownStep('Claude runtime', () => shutdownClaudeAssistantRuntime({shutdownMcp: false}));
        await runAssistantShutdownStep('assistant session persistence', () => sessionStore.flushPersistence());
        await runAssistantShutdownStep('active assistant session', () => sessionStore.clearActiveSession());
        await runAssistantShutdownStep('embedded MCP server', () => shutdownEmbeddedMcpServer());
    });
}
