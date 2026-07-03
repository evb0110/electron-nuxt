import type { IAgentAssistantChatScope } from '@contracts/agent';
import type {
    IAssistantChatSession,
    TAssistantChatSessionStore,
} from '@electron/features/agent/assistantChatSessionStore';
import type { TAssistantProviderRuntimeStateMap } from '@electron/features/agent/assistantProviderState';
import { getAssistantProviderRuntimeState } from '@electron/features/agent/assistantProviderState';
import {
    claimAssistantTurn,
    completeAssistantTurn,
    errorAssistantTurn,
    getAssistantTurnPhase,
    getAssistantTurnProviderTurnId,
    getAssistantTurnScope,
    markAssistantTurnInterrupting,
    markAssistantTurnRunning,
    supersedeAssistantTurn,
    type IAssistantSessionScopeBinding,
} from '@electron/features/agent/assistantTurnLifecycle';
import { syncAssistantMcpSessionScope } from '@electron/features/agent/assistantMcpSessionScope';

interface IAssistantSessionTurnCoordinatorOptions {
    providerRuntimeStates: TAssistantProviderRuntimeStateMap;
    sessionStore: TAssistantChatSessionStore;
}

export function createAssistantSessionTurnCoordinator(options: IAssistantSessionTurnCoordinatorOptions) {
    function createAssistantSessionScopeBinding(
        session: IAssistantChatSession,
    ): Omit<IAssistantSessionScopeBinding, 'turnGeneration'> {
        return {
            sessionKey: options.sessionStore.keyForSession(session),
            provider: session.provider,
            windowId: session.lastSenderWindowId ?? -1,
            tabId: session.scope.tabId ?? '',
            documentRef: session.scope.documentRef ?? null,
            ...(session.scope.documentBackend === undefined ? {} : {documentBackend: session.scope.documentBackend}),
            documentIdentity: session.scope.documentIdentity ?? null,
            ...(session.scope.commandTarget === undefined ? {} : {commandTarget: {...session.scope.commandTarget}}),
        };
    }

    function syncSessionTurnFields(session: IAssistantChatSession) {
        session.activeTurnId = getAssistantTurnProviderTurnId(session.turnOwner);
        session.turnPhase = getAssistantTurnPhase(session.turnOwner);
        session.scopeBinding = getAssistantTurnScope(session.turnOwner);
        syncAssistantMcpSessionScope(options.sessionStore.keyForSession(session), session.scopeBinding);
    }

    function syncProviderRuntimeFromSession(session: IAssistantChatSession) {
        const providerRuntime = getAssistantProviderRuntimeState(options.providerRuntimeStates, session.provider);
        providerRuntime.activeTurnId = session.activeTurnId;
        providerRuntime.turnPhase = session.turnPhase;
    }

    function claimSessionTurn(session: IAssistantChatSession) {
        session.turnOwner = claimAssistantTurn(session.turnOwner, createAssistantSessionScopeBinding(session));
        syncSessionTurnFields(session);
        syncProviderRuntimeFromSession(session);
        return session.turnOwner.generation;
    }

    function markSessionTurnRunning(
        session: IAssistantChatSession,
        generation: number,
        providerTurnId: string | null,
    ) {
        const previousOwner = session.turnOwner;
        session.turnOwner = markAssistantTurnRunning(session.turnOwner, generation, providerTurnId);
        syncSessionTurnFields(session);
        syncProviderRuntimeFromSession(session);
        return session.turnOwner !== previousOwner;
    }

    function completeSessionTurn(
        session: IAssistantChatSession,
        generation: number,
        providerTurnId?: string | null,
    ) {
        const previousOwner = session.turnOwner;
        session.turnOwner = completeAssistantTurn(session.turnOwner, generation, providerTurnId);
        syncSessionTurnFields(session);
        syncProviderRuntimeFromSession(session);
        return session.turnOwner !== previousOwner;
    }

    function errorSessionTurn(
        session: IAssistantChatSession,
        generation: number,
        error: string,
        providerTurnId?: string | null,
    ) {
        const previousOwner = session.turnOwner;
        session.turnOwner = errorAssistantTurn(session.turnOwner, generation, error, providerTurnId);
        syncSessionTurnFields(session);
        syncProviderRuntimeFromSession(session);
        return session.turnOwner !== previousOwner;
    }

    function supersedeSessionTurnWithError(session: IAssistantChatSession, error: string) {
        const supersededOwner = supersedeAssistantTurn(session.turnOwner);
        session.turnOwner = errorAssistantTurn(supersededOwner, supersededOwner.generation, error);
        syncSessionTurnFields(session);
        syncProviderRuntimeFromSession(session);
    }

    function interruptSessionTurn(session: IAssistantChatSession) {
        session.turnOwner = markAssistantTurnInterrupting(session.turnOwner);
        syncSessionTurnFields(session);
        syncProviderRuntimeFromSession(session);
    }

    function supersedeSessionTurn(session: IAssistantChatSession) {
        session.turnOwner = supersedeAssistantTurn(session.turnOwner);
        syncSessionTurnFields(session);
        syncProviderRuntimeFromSession(session);
    }

    function rememberStateScope(
        scope: IAgentAssistantChatScope | null,
        selection = options.sessionStore.getRememberedSelection(),
    ) {
        options.sessionStore.rememberStateScope(scope, selection);
    }

    return {
        claimSessionTurn,
        completeSessionTurn,
        errorSessionTurn,
        interruptSessionTurn,
        markSessionTurnRunning,
        rememberStateScope,
        supersedeSessionTurn,
        supersedeSessionTurnWithError,
    };
}
