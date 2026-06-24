import type {
    IAgentAssistantChatScope,
    IAgentAssistantProviderStatus,
    IAgentAssistantState,
    IAgentAssistantStatus,
    TAgentAssistantEffort,
    TAgentAssistantProviderId,
} from '@contracts/agent';

export function cloneAssistantScope(scope: IAgentAssistantChatScope): IAgentAssistantChatScope {
    return {
        kind: scope.kind,
        key: scope.key,
        title: scope.title,
        ...(scope.tabId == null ? {} : {tabId: scope.tabId}),
        ...(scope.documentRef == null ? {} : {documentRef: scope.documentRef}),
    };
}

export function modelForSelection(
    providerStatus: IAgentAssistantProviderStatus,
    model: string,
) {
    return providerStatus.models.find(candidate => candidate.id === model)
        ?? providerStatus.models.find(candidate => candidate.id === providerStatus.defaultModel)
        ?? providerStatus.models[0]
        ?? null;
}

export function createSelectedAssistantStatus(
    baseStatus: IAgentAssistantStatus,
    providerStatus: IAgentAssistantProviderStatus,
    model: string,
    effort: TAgentAssistantEffort,
) {
    const selectedModelOption = modelForSelection(providerStatus, model);
    const selectedModel = selectedModelOption?.id ?? model;
    const selectedModelLabel = selectedModelOption?.label ?? selectedModel;
    const selectedEffortValue = providerStatus.availableEfforts.includes(effort)
        ? effort
        : providerStatus.defaultEffort;
    const providers = baseStatus.providers.map(candidate => (candidate.id === providerStatus.id
        ? {
            ...candidate,
            activeModel: selectedModel,
            activeEffort: selectedEffortValue,
        }
        : candidate));
    const codexProvider = providerStatus.id === 'codex'
        ? providerStatus
        : providers.find(candidate => candidate.id === 'codex');
    const preserveTurn = baseStatus.provider === providerStatus.id;
    const {
        error: _baseError,
        ...baseStatusWithoutError
    } = baseStatus;

    return {
        ...baseStatusWithoutError,
        provider: providerStatus.id,
        providerLabel: providerStatus.label,
        providers,
        model: selectedModel,
        modelLabel: selectedModelLabel,
        models: providerStatus.models,
        modelSwitchMode: providerStatus.modelSwitchMode,
        effort: selectedEffortValue,
        availableEfforts: providerStatus.availableEfforts,
        installState: providerStatus.installState,
        codexInstalled: codexProvider?.installState === 'installed',
        codexPath: codexProvider?.path ?? null,
        codexVersion: codexProvider?.version ?? null,
        minimumCodexVersion: codexProvider?.minimumVersion ?? baseStatus.minimumCodexVersion,
        codexVersionSupported: codexProvider?.versionSupported ?? baseStatus.codexVersionSupported,
        installUrl: providerStatus.installUrl,
        authState: providerStatus.authState,
        account: providerStatus.account,
        runtimeState: providerStatus.runtimeState,
        turn: preserveTurn
            ? baseStatus.turn
            : {
                id: null,
                phase: 'idle',
            },
        threadId: preserveTurn ? baseStatus.threadId : null,
        activeTurnId: preserveTurn ? baseStatus.activeTurnId : null,
        ...(providerStatus.error ? {error: providerStatus.error} : {}),
    } satisfies IAgentAssistantStatus;
}

export function getStateScopeKey(nextState: IAgentAssistantState) {
    return nextState.scope?.key ?? null;
}

export function providerDefaultModel(
    providers: readonly IAgentAssistantProviderStatus[],
    provider: TAgentAssistantProviderId,
) {
    const providerStatus = providers.find(candidate => candidate.id === provider);
    return providerStatus?.activeModel
        ?? providerStatus?.defaultModel
        ?? 'default';
}

export function providerDefaultEffort(
    providers: readonly IAgentAssistantProviderStatus[],
    provider: TAgentAssistantProviderId,
): TAgentAssistantEffort {
    const providerStatus = providers.find(candidate => candidate.id === provider);
    return providerStatus?.activeEffort
        ?? providerStatus?.defaultEffort
        ?? 'high';
}

function unwrapSelectionValue(value: unknown) {
    return typeof value === 'object' && value && 'value' in value
        ? (value as {value?: unknown}).value
        : value;
}

export function normalizeEffortValue(value: unknown): TAgentAssistantEffort | null {
    const id = unwrapSelectionValue(value);
    return id === 'low' || id === 'medium' || id === 'high' || id === 'xhigh' || id === 'max'
        ? id
        : null;
}

export function normalizeProviderValue(value: unknown): TAgentAssistantProviderId {
    const id = unwrapSelectionValue(value);
    return id === 'claude' ? 'claude' : 'codex';
}

export function normalizeModelValue(value: unknown) {
    const id = unwrapSelectionValue(value);
    return typeof id === 'string' ? id : null;
}
