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

// Canonical Claude model options, smartest first. Ids are Claude Code aliases;
// Anthropic documents that these aliases can lag or be pinned by environment,
// so labels are version-aware fallback metadata rather than freshness guarantees.
export const CLAUDE_ASSISTANT_DEFAULT_MODEL = 'fable';

export const CLAUDE_ASSISTANT_MODELS = [
    {
        id: 'fable',
        label: 'Claude Fable 5',
    },
    {
        id: 'opus',
        label: 'Claude Opus 4.8',
    },
    {
        id: 'sonnet',
        label: 'Claude Sonnet 4.6',
    },
    {
        id: 'haiku',
        label: 'Claude Haiku 4.5',
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
