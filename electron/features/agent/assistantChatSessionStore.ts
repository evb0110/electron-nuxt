import { randomUUID } from 'crypto';
import type {
    IAgentAssistantChatMessage,
    IAgentAssistantChatScope,
    IAgentAssistantEvent,
    IAgentAssistantImageAttachment,
    IAgentAssistantScopedRequest,
    IAgentAssistantStateRequest,
    TAgentAssistantEffort,
    TAgentAssistantProviderId,
    TAgentAssistantSpeedMode,
    TAgentAssistantTurnPhase,
} from '@contracts/agent';
import {
    ASSISTANT_DEFAULT_EFFORT,
    ASSISTANT_DEFAULT_SPEED_MODE,
    CODEX_ASSISTANT_DEFAULT_MODEL,
} from '@contracts/agentModels';
import { isDocumentRevisionInfo } from '@contracts/documentRevision';
import type { ClaudeAgentAssistantSession } from '@electron/features/agent/claudeAgentSdkAssistant';
import { withAssistantErrorEnvelope } from '@electron/features/agent/assistantErrorEnvelope';
import type { IAssistantSelection } from '@electron/features/agent/assistantProviderStatus';
import {
    createInitialAssistantTurnOwner,
    isAssistantTurnActive,
    type IAssistantSessionScopeBinding,
    type TAssistantTurnOwnerState,
} from '@electron/features/agent/assistantTurnLifecycle';

export interface IAssistantChatSession {
    provider: TAgentAssistantProviderId;
    scope: IAgentAssistantChatScope;
    model: string;
    effort: TAgentAssistantEffort;
    speedMode: TAgentAssistantSpeedMode;
    threadId: string | null;
    lastSenderWindowId: number | null;
    turnOwner: TAssistantTurnOwnerState;
    sendInFlight: Promise<unknown> | null;
    scopeBinding: IAssistantSessionScopeBinding | null;
    activeTurnId: string | null;
    turnPhase: TAgentAssistantTurnPhase;
    messages: IAgentAssistantChatMessage[];
    lastAccessedAtMs: number;
    claudeSession: ClaudeAgentAssistantSession | undefined;
    lastError?: string;
}

interface IAssistantChatSessionStoreOptions {
    maxEntries?: number;
    ttlMs?: number;
    onSessionDeleted?: (session: IAssistantChatSession, reason: string) => void;
    onSessionMessageEvent?: (event: IAgentAssistantEvent, session: IAssistantChatSession) => void;
}

type TAssistantMessageInput = Omit<IAgentAssistantChatMessage, 'id' | 'createdAt'> & { id?: string };

const DEFAULT_SELECTION = {
    provider: 'codex',
    model: CODEX_ASSISTANT_DEFAULT_MODEL,
    effort: ASSISTANT_DEFAULT_EFFORT,
    speedMode: ASSISTANT_DEFAULT_SPEED_MODE,
} as const satisfies IAssistantSelection;

function readBoundedIntegerEnv(name: string, fallback: number, minimum: number, maximum?: number) {
    const parsed = Number.parseInt(process.env[name] ?? `${fallback}`, 10);
    if (!Number.isFinite(parsed) || parsed < minimum) {
        return fallback;
    }
    return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

function readAssistantChatSessionMaxEntries() {
    return readBoundedIntegerEnv('EVB_ASSISTANT_CHAT_SESSION_MAX_ENTRIES', 32, 1, 512);
}

function readAssistantChatSessionTtlMs() {
    return readBoundedIntegerEnv('EVB_ASSISTANT_CHAT_SESSION_TTL_MS', 60 * 60 * 1000, 60_000);
}

export function cloneAssistantScope(scope: IAgentAssistantChatScope): IAgentAssistantChatScope {
    return {
        kind: scope.kind,
        key: scope.key,
        title: scope.title,
        ...(scope.tabId == null ? {} : { tabId: scope.tabId }),
        ...(scope.documentRef == null ? {} : { documentRef: scope.documentRef }),
        ...(scope.documentBackend === undefined ? {} : {documentBackend: scope.documentBackend}),
        ...(scope.documentIdentity == null ? {} : { documentIdentity: { ...scope.documentIdentity } }),
        ...(scope.commandTarget === undefined ? {} : {commandTarget: {...scope.commandTarget}}),
    };
}

export function normalizeAssistantScope(scope: IAgentAssistantChatScope | null | undefined) {
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
        ...(scope.documentBackend === 'browser' || scope.documentBackend === 'electron'
            ? {documentBackend: scope.documentBackend}
            : {}),
        ...(isDocumentRevisionInfo(scope.documentIdentity) ? { documentIdentity: { ...scope.documentIdentity } } : {}),
        ...(scope.commandTarget === undefined ? {} : {commandTarget: {...scope.commandTarget}}),
    } satisfies IAgentAssistantChatScope;
}

function createChatSessionKey(provider: TAgentAssistantProviderId, scopeKey: string) {
    return `${provider}:${scopeKey}`;
}

function cloneAssistantAttachment(attachment: IAgentAssistantImageAttachment) {
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

function isEvictableChatSession(session: IAssistantChatSession) {
    return session.activeTurnId === null
        && !isAssistantTurnActive(session.turnOwner)
        && session.turnPhase !== 'starting'
        && session.turnPhase !== 'running'
        && session.turnPhase !== 'interrupting';
}

export function createAssistantChatSessionStore(options: IAssistantChatSessionStoreOptions = {}) {
    const maxEntries = options.maxEntries ?? readAssistantChatSessionMaxEntries();
    const ttlMs = options.ttlMs ?? readAssistantChatSessionTtlMs();
    const chatSessions = new Map<string, IAssistantChatSession>();
    let activeChatKey: string | null = null;
    let lastStateScope: IAgentAssistantChatScope | null = null;
    let lastSelection: IAssistantSelection = DEFAULT_SELECTION;

    function getRememberedScope() {
        return lastStateScope;
    }

    function getRememberedSelection() {
        return lastSelection;
    }

    function rememberStateScope(
        scope: IAgentAssistantChatScope | null,
        selection: IAssistantSelection = lastSelection,
    ) {
        lastStateScope = scope ? cloneAssistantScope(scope) : null;
        lastSelection = selection;
    }

    function updateRememberedSelection(patch: Partial<IAssistantSelection>) {
        lastSelection = {
            ...lastSelection,
            ...patch,
        };
    }

    function resolveRequestedScope(request?: IAgentAssistantStateRequest | IAgentAssistantScopedRequest | null) {
        return normalizeAssistantScope(request?.scope);
    }

    function touchSession(session: IAssistantChatSession, now = Date.now()) {
        session.lastAccessedAtMs = now;
        return session;
    }

    function keyForSession(session: IAssistantChatSession) {
        return createChatSessionKey(session.provider, session.scope.key);
    }

    function clearActiveSession() {
        activeChatKey = null;
    }

    function clearActiveSessionForProvider(provider: TAgentAssistantProviderId) {
        if (activeChatKey && chatSessions.get(activeChatKey)?.provider === provider) {
            activeChatKey = null;
        }
    }

    function clearActiveSessionIfMatches(session: IAssistantChatSession) {
        if (activeChatKey === keyForSession(session)) {
            activeChatKey = null;
        }
    }

    function setActiveSession(session: IAssistantChatSession) {
        activeChatKey = keyForSession(session);
    }

    function deleteSession(key: string, reason: string) {
        const session = chatSessions.get(key);
        if (!session) {
            return;
        }

        chatSessions.delete(key);
        if (activeChatKey === key) {
            activeChatKey = null;
        }
        if (lastStateScope?.key === session.scope.key && lastSelection.provider === session.provider) {
            lastStateScope = null;
        }

        options.onSessionDeleted?.(session, reason);
    }

    function pruneSessions(now = Date.now()) {
        for (const [
            key,
            session,
        ] of chatSessions.entries()) {
            if (isEvictableChatSession(session) && now - session.lastAccessedAtMs > ttlMs) {
                deleteSession(key, 'expired');
            }
        }

        if (chatSessions.size <= maxEntries) {
            return;
        }

        const evictableSessions = [...chatSessions.entries()]
            .filter((entry) => isEvictableChatSession(entry[1]))
            .sort((left, right) => left[1].lastAccessedAtMs - right[1].lastAccessedAtMs);
        const overflowCount = chatSessions.size - maxEntries;
        for (let index = 0; index < overflowCount; index += 1) {
            const entry = evictableSessions[index];
            if (!entry) {
                break;
            }
            deleteSession(entry[0], 'evicted');
        }
    }

    function getSession(scope: IAgentAssistantChatScope, selection: IAssistantSelection, getOptions: { create: true }): IAssistantChatSession;
    function getSession(scope: IAgentAssistantChatScope | null, selection?: IAssistantSelection, getOptions?: { create?: false }): IAssistantChatSession | null;
    function getSession(
        scope: IAgentAssistantChatScope | null,
        selection: IAssistantSelection = lastSelection,
        getOptions: { create?: boolean } = {},
    ) {
        const now = Date.now();
        pruneSessions(now);
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
            return touchSession(existing, now);
        }

        if (!getOptions.create) {
            return null;
        }

        const session = {
            provider: selection.provider,
            scope: normalizedScope,
            model: selection.model,
            effort: selection.effort,
            speedMode: selection.speedMode,
            threadId: null,
            lastSenderWindowId: null,
            turnOwner: createInitialAssistantTurnOwner(),
            sendInFlight: null,
            scopeBinding: null,
            activeTurnId: null,
            turnPhase: 'idle',
            messages: [],
            lastAccessedAtMs: now,
            claudeSession: undefined,
        } satisfies IAssistantChatSession;
        chatSessions.set(sessionKey, session);
        pruneSessions(now);
        return session;
    }

    function getActiveSession(provider?: TAgentAssistantProviderId) {
        const session = activeChatKey ? chatSessions.get(activeChatKey) ?? null : null;
        if (provider && session?.provider !== provider) {
            return null;
        }
        return session ? touchSession(session) : null;
    }

    function getSessionByThreadId(candidateThreadId: string | null) {
        if (!candidateThreadId) {
            return null;
        }

        const session = Array.from(chatSessions.values())
            .find(candidate => candidate.provider === 'codex' && candidate.threadId === candidateThreadId) ?? null;
        return session ? touchSession(session) : null;
    }

    function getMessages(scope: IAgentAssistantChatScope | null = lastStateScope, selection: IAssistantSelection = lastSelection) {
        return getSession(scope, selection)?.messages.map(cloneAssistantMessage) ?? [];
    }

    function listSessions() {
        return [...chatSessions.values()];
    }

    function addMessage(session: IAssistantChatSession, message: TAssistantMessageInput) {
        touchSession(session);
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
        options.onSessionMessageEvent?.({
            type: 'message',
            message: nextMessage,
        }, session);
        return nextMessage;
    }

    function upsertAssistantMessage(
        session: IAssistantChatSession,
        id: string,
        patch: Partial<IAgentAssistantChatMessage>,
    ) {
        touchSession(session);
        const existing = session.messages.find(message => message.id === id);
        if (existing) {
            Object.assign(existing, patch);
            options.onSessionMessageEvent?.({
                type: 'message',
                message: cloneAssistantMessage(existing),
            }, session);
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
        touchSession(session);
        const message = session.messages.find(candidate => candidate.id === messageId)
            ?? addMessage(session, {
                id: messageId,
                role: 'assistant',
                text: '',
                pending: true,
            });
        message.pending = true;
        message.text += delta;
        options.onSessionMessageEvent?.({
            type: 'message-delta',
            messageId,
            delta,
        }, session);
    }

    return {
        addMessage,
        appendAssistantDelta,
        clearActiveSession,
        clearActiveSessionForProvider,
        clearActiveSessionIfMatches,
        deleteSession,
        getActiveSession,
        getMessages,
        getRememberedScope,
        getRememberedSelection,
        getSession,
        getSessionByThreadId,
        keyForSession,
        listSessions,
        rememberStateScope,
        resolveRequestedScope,
        setActiveSession,
        touchSession,
        updateRememberedSelection,
        upsertAssistantMessage,
    };
}

export type TAssistantChatSessionStore = ReturnType<typeof createAssistantChatSessionStore>;
