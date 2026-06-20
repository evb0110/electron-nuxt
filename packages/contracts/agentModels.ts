import type {
    IAgentAssistantModelOption,
    TAgentAssistantEffort,
} from '@contracts/agent';

// Reasoning effort. 'high' is the SDK/CLI default sweet spot. Codex exposes the lower
// three levels; xhigh/max are Claude-only.
export const ASSISTANT_DEFAULT_EFFORT = 'high' satisfies TAgentAssistantEffort;
export const CLAUDE_ASSISTANT_EFFORTS = [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
] as const satisfies readonly TAgentAssistantEffort[];
export const CODEX_ASSISTANT_EFFORTS = [
    'low',
    'medium',
    'high',
] as const satisfies readonly TAgentAssistantEffort[];

// Canonical Claude model options, smartest first. Ids are Agent SDK aliases that always
// resolve to the latest version of each family. Fable stays selectable even though it is
// access-gated — selecting it simply returns an "unavailable" error until the account is
// granted access, at which point it works with no code change. The default is the smartest
// model that is generally available today (Opus); switch to Fable here once it ships broadly.
export const CLAUDE_ASSISTANT_DEFAULT_MODEL = 'opus';

export const CLAUDE_ASSISTANT_MODELS = [
    {
        id: 'fable',
        label: 'Fable',
    },
    {
        id: 'opus',
        label: 'Opus',
    },
    {
        id: 'sonnet',
        label: 'Sonnet',
    },
    {
        id: 'haiku',
        label: 'Haiku',
    },
] as const satisfies readonly IAgentAssistantModelOption[];

export const CODEX_ASSISTANT_DEFAULT_MODEL = 'gpt-5.5';

export const CODEX_ASSISTANT_FALLBACK_MODELS = [
    {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
    },
    {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
    },
    {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4-Mini',
    },
    {
        id: 'gpt-5.3-codex-spark',
        label: 'GPT-5.3-Codex-Spark',
    },
] as const satisfies readonly IAgentAssistantModelOption[];
