import type {
    IAgentAssistantAccount,
    IAgentAssistantModelOption,
    IAgentAssistantStatus,
    TAgentAssistantAuthState,
    TAgentAssistantEffort,
    TAgentAssistantProviderId,
    TAgentAssistantRuntimeState,
    TAgentAssistantSpeedMode,
    TAgentAssistantTurnPhase,
} from '@contracts/agent';
import type { ICodexCliInfo } from '@electron/features/agent/codexCli';
import type { TCodexAssistantModelOption } from '@electron/features/agent/assistantModelCatalog';
import {
    buildClaudeProviderStatus,
    buildCodexProviderStatus,
    type IClaudeAssistantProviderInfo,
} from '@electron/features/agent/assistantProviderStatus';
import { ASSISTANT_PROVIDER_IDS } from '@electron/features/agent/assistantProviderRegistry';

export interface IAssistantProviderRuntimeState {
    authState: TAgentAssistantAuthState;
    runtimeState: TAgentAssistantRuntimeState;
    account: IAgentAssistantAccount | null;
    activeTurnId: string | null;
    turnPhase: TAgentAssistantTurnPhase;
    lastError?: string;
}

export type TAssistantProviderRuntimeStateMap = Record<TAgentAssistantProviderId, IAssistantProviderRuntimeState>;

type TAssistantProviderRuntimeStatePatch = Partial<IAssistantProviderRuntimeState>;
type TAssistantProviderRuntimeStateOverrides = Partial<Record<TAgentAssistantProviderId, TAssistantProviderRuntimeStatePatch>>;

function createAssistantProviderRuntimeState(
    overrides: TAssistantProviderRuntimeStatePatch = {},
): IAssistantProviderRuntimeState {
    return {
        authState: 'unknown',
        runtimeState: 'stopped',
        account: null,
        activeTurnId: null,
        turnPhase: 'idle',
        ...overrides,
    };
}

export function createAssistantProviderRuntimeStates(
    overrides: TAssistantProviderRuntimeStateOverrides = {},
): TAssistantProviderRuntimeStateMap {
    return Object.fromEntries(
        ASSISTANT_PROVIDER_IDS.map(provider => [
            provider,
            createAssistantProviderRuntimeState(overrides[provider]),
        ]),
    ) as TAssistantProviderRuntimeStateMap;
}

export function getAssistantProviderRuntimeState(
    states: TAssistantProviderRuntimeStateMap,
    provider: TAgentAssistantProviderId,
) {
    return states[provider];
}

export function updateAssistantProviderRuntimeState(
    states: TAssistantProviderRuntimeStateMap,
    provider: TAgentAssistantProviderId,
    patch: TAssistantProviderRuntimeStatePatch,
) {
    Object.assign(states[provider], patch);
    if ('lastError' in patch && patch.lastError === undefined) {
        delete states[provider].lastError;
    }
    return states[provider];
}

export function buildAssistantProviderStatuses(options: {
    platform: string;
    states: TAssistantProviderRuntimeStateMap;
    codexInfo: ICodexCliInfo | null;
    claudeInfo: IClaudeAssistantProviderInfo | null;
    codexModels: readonly TCodexAssistantModelOption[];
    claudeModels: readonly IAgentAssistantModelOption[];
    model: string;
    effort: TAgentAssistantEffort;
    speedMode: TAgentAssistantSpeedMode;
}): IAgentAssistantStatus['providers'] {
    const codexState = getAssistantProviderRuntimeState(options.states, 'codex');
    const claudeState = getAssistantProviderRuntimeState(options.states, 'claude');
    return [
        buildCodexProviderStatus({
            platform: options.platform,
            codexInfo: options.codexInfo,
            models: options.codexModels,
            model: options.model,
            effort: options.effort,
            speedMode: options.speedMode,
            authState: codexState.authState,
            runtimeState: codexState.runtimeState,
            account: codexState.account,
            ...(codexState.lastError ? { lastError: codexState.lastError } : {}),
        }),
        buildClaudeProviderStatus({
            platform: options.platform,
            claudeInfo: options.claudeInfo,
            models: options.claudeModels,
            model: options.model,
            effort: options.effort,
            speedMode: options.speedMode,
            authState: claudeState.authState,
            runtimeState: claudeState.runtimeState,
            account: claudeState.account,
            ...(claudeState.lastError ? { lastError: claudeState.lastError } : {}),
        }),
    ];
}
