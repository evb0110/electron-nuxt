import type { TAgentAssistantProviderId } from '@contracts/agent';

export const ASSISTANT_PROVIDER_IDS = [
    'codex',
    'claude',
] as const satisfies readonly TAgentAssistantProviderId[];

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
