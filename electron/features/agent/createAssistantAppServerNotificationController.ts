import type {
    IAgentAssistantChatScope,
    IAgentAssistantEvent,
    IAgentAssistantStatus,
} from '@contracts/agent';
import { buildAgentAssistantScopeFingerprint } from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';
import type {
    IAssistantChatSession,
    TAssistantChatSessionStore,
} from '@electron/features/agent/assistantChatSessionStore';
import type { IAssistantProviderRuntimeState } from '@electron/features/agent/assistantProviderState';
import type { IAssistantSelection } from '@electron/features/agent/assistantProviderStatus';
import {
    canCompleteAssistantTurnWithoutProviderTurn,
    buildAssistantSessionScopeBindingFingerprint,
    getAssistantTurnPhase,
    getAssistantTurnProviderTurnId,
    getAssistantTurnScope,
    type ICompleteAssistantTurnOptions,
    isAssistantTurnActive,
} from '@electron/features/agent/assistantTurnLifecycle';
import type { ICodexAppServerNotification } from '@electron/features/agent/codexAppServerClient';
import {
    focusAssistantReturnWindow,
    type TAssistantReturnWindow,
} from '@electron/features/agent/assistantReturnWindow';

interface IAssistantAppServerNotificationsLogger { info(message: string): void; }

interface IAssistantAppServerNotificationsOptions {
    addMessage: (
        session: IAssistantChatSession,
        message: Parameters<TAssistantChatSessionStore['addMessage']>[1],
    ) => unknown;
    appendAssistantDelta: (session: IAssistantChatSession, messageId: string, delta: string) => void;
    clearLoginState: () => void;
    clearRuntimeForExit: () => void;
    codexProviderRuntime: IAssistantProviderRuntimeState;
    completeSessionTurn: (
        session: IAssistantChatSession,
        generation: number,
        providerTurnId?: string | null,
        completeOptions?: ICompleteAssistantTurnOptions,
    ) => boolean;
    currentCodexSelection: () => IAssistantSelection;
    errorSessionTurn: (
        session: IAssistantChatSession,
        generation: number,
        error: string,
        providerTurnId?: string | null,
    ) => boolean;
    getActiveChatSession: () => IAssistantChatSession | null;
    getAuthReturnWindow: () => TAssistantReturnWindow;
    getChatSessionByThreadId: (threadId: string | null) => IAssistantChatSession | null;
    getRememberedScope: () => IAgentAssistantChatScope | null;
    logger: IAssistantAppServerNotificationsLogger;
    markSessionTurnRunning: (
        session: IAssistantChatSession,
        generation: number,
        providerTurnId: string | null,
    ) => boolean;
    noFocus: boolean;
    publishAssistantEvent: (
        event: IAgentAssistantEvent,
        scope?: IAgentAssistantChatScope | null,
        selection?: IAssistantSelection,
    ) => void;
    publishState: (scope?: IAgentAssistantChatScope | null, selection?: IAssistantSelection) => void;
    reconcileFailedTurnMessages: (session: IAssistantChatSession, errorMessage: string) => void;
    refreshAuthStateAndRuntimeAvailability: (options?: { recoverFromError?: boolean }) => Promise<void>;
    sessionStore: Pick<TAssistantChatSessionStore, 'listSessions' | 'recordSessionSnapshot' | 'setActiveSession'>;
    supersedeSessionTurn: (session: IAssistantChatSession) => void;
    upsertAssistantMessage: (
        session: IAssistantChatSession,
        id: string,
        patch: Parameters<TAssistantChatSessionStore['upsertAssistantMessage']>[2],
    ) => unknown;
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

function getNotificationTurnId(params: unknown) {
    if (!isRecord(params)) {
        return null;
    }
    if (typeof params.turnId === 'string') {
        return params.turnId;
    }
    if (isRecord(params.turn) && typeof params.turn.id === 'string') {
        return params.turn.id;
    }
    if (isRecord(params.item) && typeof params.item.turnId === 'string') {
        return params.item.turnId;
    }
    return null;
}

function isCodexTurnNotification(method: string) {
    return method === 'turn/started'
        || method === 'turn/completed'
        || method === 'item/agentMessage/delta'
        || method === 'item/completed'
        || method === 'error';
}

export function createAssistantAppServerNotificationController(options: IAssistantAppServerNotificationsOptions) {
    function shouldIgnoreThreadNotification(method: string, params: unknown) {
        const notificationThreadId = getNotificationThreadId(params);
        if (!notificationThreadId) {
            return false;
        }
        if (method === 'thread/started') {
            return false;
        }
        return !options.getChatSessionByThreadId(notificationThreadId);
    }

    function getNotificationChatSession(params: unknown) {
        return options.getChatSessionByThreadId(getNotificationThreadId(params));
    }

    function shouldDropNotificationForTurn(
        session: IAssistantChatSession,
        params: unknown,
        bindOptions: Parameters<typeof bindNotificationTurn>[2] = {},
    ) {
        const turnId = getNotificationTurnId(params);
        return !bindNotificationTurn(session, turnId, bindOptions);
    }

    function isActiveTurnScopeCurrent(session: IAssistantChatSession) {
        const turnScope = getAssistantTurnScope(session.turnOwner);
        return !turnScope
            || buildAssistantSessionScopeBindingFingerprint(turnScope)
                === buildAgentAssistantScopeFingerprint(session.provider, session.scope);
    }

    function bindNotificationTurn(
        session: IAssistantChatSession,
        turnId: string | null,
        optionsOverride: {
            emitStartedEvent?: boolean;
            allowStaleScope?: boolean;
        } = {},
    ) {
        const allowStaleScope = optionsOverride.allowStaleScope ?? false;
        if (turnId === null) {
            return isAssistantTurnActive(session.turnOwner)
                && (allowStaleScope || isActiveTurnScopeCurrent(session));
        }

        const activeProviderTurnId = getAssistantTurnProviderTurnId(session.turnOwner);
        if (activeProviderTurnId === turnId) {
            return allowStaleScope || isActiveTurnScopeCurrent(session);
        }
        if (activeProviderTurnId !== null || !isAssistantTurnActive(session.turnOwner)) {
            return false;
        }
        if (!isActiveTurnScopeCurrent(session)) {
            return false;
        }

        const generation = session.turnOwner.generation;
        if (!options.markSessionTurnRunning(session, generation, turnId)) {
            return getAssistantTurnProviderTurnId(session.turnOwner) === turnId;
        }

        options.sessionStore.setActiveSession(session);
        options.codexProviderRuntime.runtimeState = 'busy';
        if (optionsOverride.emitStartedEvent ?? true) {
            options.publishAssistantEvent({
                type: 'turn-started',
                turnId,
            }, session.scope, session);
        }
        return true;
    }

    function handleNotification(notification: ICodexAppServerNotification) {
        const method = typeof notification.method === 'string' ? notification.method : '';
        const params = notification.params;
        if (shouldIgnoreThreadNotification(method, params)) {
            options.logger.info(`Ignoring stale assistant notification for inactive thread: ${method}`);
            return;
        }

        if (method === 'account/login/completed') {
            const success = isRecord(params) && params.success === true;
            const error = isRecord(params) && typeof params.error === 'string' ? params.error : null;
            if (success) {
                focusAssistantReturnWindow(options.getAuthReturnWindow(), { noFocus: options.noFocus });
            }
            options.clearLoginState();
            options.codexProviderRuntime.authState = success ? 'signed-in' : 'signed-out';
            if (success) {
                delete options.codexProviderRuntime.lastError;
            } else {
                options.codexProviderRuntime.lastError = error ?? 'ChatGPT sign-in failed.';
            }
            void options.refreshAuthStateAndRuntimeAvailability({ recoverFromError: success }).finally(options.publishState);
            return;
        }

        if (method === 'account/updated') {
            void options.refreshAuthStateAndRuntimeAvailability().finally(options.publishState);
            return;
        }

        if (isCodexTurnNotification(method) && !getNotificationThreadId(params)) {
            options.logger.info(`Ignoring assistant notification without thread id: ${method}`);
            return;
        }

        if (method === 'turn/started') {
            const session = getNotificationChatSession(params);
            if (!session) {
                return;
            }
            const turnId = getNotificationTurnId(params);
            const turnAlreadyBound = turnId !== null && getAssistantTurnProviderTurnId(session.turnOwner) === turnId;
            if (!bindNotificationTurn(session, turnId, { emitStartedEvent: false })) {
                options.logger.info(`Ignoring stale assistant turn start: ${method}`);
                return;
            }
            options.sessionStore.setActiveSession(session);
            options.codexProviderRuntime.runtimeState = 'busy';
            if (!turnAlreadyBound) {
                options.publishAssistantEvent({
                    type: 'turn-started',
                    ...(turnId ? { turnId } : {}),
                }, session.scope, session);
            }
            return;
        }

        if (method === 'turn/completed') {
            const session = getNotificationChatSession(params);
            if (!session) {
                return;
            }
            const turnId = getNotificationTurnId(params);
            if (!bindNotificationTurn(session, turnId, {allowStaleScope: true})) {
                options.logger.info('Ignoring stale assistant turn completion.');
                return;
            }
            const allowStartingWithoutProviderTurn = turnId === null
                && getAssistantTurnProviderTurnId(session.turnOwner) === null
                && getAssistantTurnPhase(session.turnOwner) === 'starting';
            if (
                turnId === null
                && !allowStartingWithoutProviderTurn
                && !canCompleteAssistantTurnWithoutProviderTurn(session.turnOwner)
            ) {
                options.logger.info('Ignoring assistant turn completion without active running turn.');
                return;
            }
            if (!options.completeSessionTurn(
                session,
                session.turnOwner.generation,
                turnId,
                {allowStartingWithoutProviderTurn},
            )) {
                options.logger.info('Ignoring stale assistant turn completion.');
                return;
            }
            options.codexProviderRuntime.runtimeState = 'ready';
            for (const message of session.messages) {
                if (message.role === 'assistant' && message.pending) {
                    message.pending = false;
                }
            }
            options.sessionStore.recordSessionSnapshot(session);
            options.publishAssistantEvent({ type: 'turn-completed' }, session.scope, session);
            return;
        }

        if (method === 'item/agentMessage/delta') {
            const session = getNotificationChatSession(params);
            if (!session) {
                return;
            }
            if (shouldDropNotificationForTurn(session, params)) {
                options.logger.info('Ignoring stale assistant message delta.');
                return;
            }
            const itemId = getStringParam(params, 'itemId');
            const delta = getStringParam(params, 'delta');
            if (options.codexProviderRuntime.runtimeState === 'busy') {
                options.markSessionTurnRunning(session, session.turnOwner.generation, getAssistantTurnProviderTurnId(session.turnOwner));
            }
            if (itemId && delta) {
                options.appendAssistantDelta(session, itemId, delta);
            }
            return;
        }

        if (method === 'item/completed') {
            const session = getNotificationChatSession(params);
            if (!session) {
                return;
            }
            if (shouldDropNotificationForTurn(session, params)) {
                options.logger.info('Ignoring stale assistant message completion.');
                return;
            }
            const item = getThreadItem(params);
            if (item?.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string') {
                options.upsertAssistantMessage(session, item.id, {
                    text: item.text,
                    pending: false,
                });
            }
            return;
        }

        if (method === 'error') {
            const session = getNotificationChatSession(params);
            options.codexProviderRuntime.lastError = isRecord(params) && isRecord(params.error) && typeof params.error.message === 'string'
                ? params.error.message
                : 'Codex assistant turn failed.';
            if (session) {
                session.lastError = options.codexProviderRuntime.lastError;
                if (shouldDropNotificationForTurn(session, params, {allowStaleScope: true})) {
                    options.logger.info('Ignoring stale assistant error notification.');
                    return;
                }
                options.errorSessionTurn(
                    session,
                    session.turnOwner.generation,
                    options.codexProviderRuntime.lastError,
                    getNotificationTurnId(params),
                );
            }
            options.codexProviderRuntime.runtimeState = 'error';
            if (session) {
                options.reconcileFailedTurnMessages(session, options.codexProviderRuntime.lastError);
                options.addMessage(session, {
                    role: 'system',
                    text: options.codexProviderRuntime.lastError,
                    error: options.codexProviderRuntime.lastError,
                });
            }
            options.publishAssistantEvent({
                type: 'error',
                error: options.codexProviderRuntime.lastError,
            }, session?.scope ?? options.getRememberedScope(), session ?? options.currentCodexSelection());
        }
    }

    function handleExit(message: string) {
        const session = options.getActiveChatSession();
        options.clearRuntimeForExit();
        options.codexProviderRuntime.runtimeState = 'error';
        for (const chatSession of options.sessionStore.listSessions()) {
            if (chatSession.provider !== 'codex') {
                continue;
            }
            chatSession.providerThreadId = null;
            options.supersedeSessionTurn(chatSession);
        }
        options.codexProviderRuntime.runtimeState = 'error';
        if (session) {
            options.errorSessionTurn(session, session.turnOwner.generation, message);
            session.lastError = message;
            options.sessionStore.recordSessionSnapshot(session);
        }
        options.codexProviderRuntime.lastError = message;
        options.publishAssistantEvent({
            type: 'error',
            error: message,
        }, session?.scope ?? options.getRememberedScope(), session ?? options.currentCodexSelection());
    }

    function createBaseMcpStatusWithToolCount(
        provider: IAssistantSelection['provider'],
        base: IAgentAssistantStatus['mcp'],
        codexToolCount: number,
        claudeToolCount: number,
    ) {
        return {
            ...base,
            toolCount: provider === 'claude' ? claudeToolCount : codexToolCount,
        };
    }

    return {
        createBaseMcpStatusWithToolCount,
        handleExit,
        handleNotification,
    };
}
