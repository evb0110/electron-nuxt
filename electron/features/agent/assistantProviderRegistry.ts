import {
    ASSISTANT_PROVIDER_IDS,
    type TAgentAssistantProviderId,
} from '@contracts/agent';
export { ASSISTANT_PROVIDER_IDS };

const ASSISTANT_PROVIDER_LABELS = {
    codex: 'Codex',
    claude: 'Claude',
} as const satisfies Record<TAgentAssistantProviderId, string>;

export function normalizeAssistantProviderId(provider: unknown): TAgentAssistantProviderId {
    return provider === 'claude' ? 'claude' : 'codex';
}

export function getAssistantProviderLabel(provider: TAgentAssistantProviderId) {
    return ASSISTANT_PROVIDER_LABELS[provider];
}
