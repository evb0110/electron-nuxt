import type {
    IAgentAssistantEffortOption,
    IAgentAssistantModelOption,
    TAgentAssistantEffort,
    TAgentAssistantSpeedMode,
} from '@contracts/agent';
export { ASSISTANT_KNOWN_EFFORTS } from '@contracts/agent';

// Assistant sessions should start responsive, then let the user opt into deeper
// reasoning or a slower service tier from the composer controls.
export const ASSISTANT_DEFAULT_EFFORT = 'low' satisfies TAgentAssistantEffort;
export const ASSISTANT_DEFAULT_SPEED_MODE = 'fast' satisfies TAgentAssistantSpeedMode;
export const ASSISTANT_SPEED_MODES = [
    'fast',
    'standard',
] as const satisfies readonly TAgentAssistantSpeedMode[];
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
    'xhigh',
] as const satisfies readonly TAgentAssistantEffort[];

const ASSISTANT_EFFORT_LABELS: Readonly<Record<string, string>> = {
    none: 'None',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High',
    max: 'Max',
};

export function normalizeAssistantEffortId(value: unknown): TAgentAssistantEffort | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : null;
}

function titleCaseEffortSegment(segment: string) {
    return segment ? `${segment[0]!.toUpperCase()}${segment.slice(1)}` : segment;
}

export function getAssistantEffortFallbackLabel(effort: TAgentAssistantEffort) {
    const normalized = effort.trim();
    const knownLabel = ASSISTANT_EFFORT_LABELS[normalized];
    if (knownLabel) {
        return knownLabel;
    }

    const label = normalized
        .split(/[-_\s]+/u)
        .filter(Boolean)
        .map(titleCaseEffortSegment)
        .join(' ');
    return label || normalized;
}

export function createAssistantEffortOptions(
    efforts: readonly TAgentAssistantEffort[],
    defaultEffort: TAgentAssistantEffort | null = null,
) {
    const seen = new Set<string>();
    return efforts.flatMap((effort): IAgentAssistantEffortOption[] => {
        const id = normalizeAssistantEffortId(effort);
        if (!id || seen.has(id)) {
            return [];
        }
        seen.add(id);
        return [{
            id,
            label: getAssistantEffortFallbackLabel(id),
            ...(defaultEffort === id ? { isDefault: true } : {}),
        }];
    });
}

export function getAssistantDefaultModelId(
    models: readonly IAgentAssistantModelOption[],
    fallback = 'default',
) {
    return models[0]?.id ?? fallback;
}

export function getAssistantPreferredModelId(
    models: readonly IAgentAssistantModelOption[],
    preferredFamily: string,
    fallback = 'default',
) {
    const normalizedFamily = preferredFamily.toLowerCase();
    return models.find(model => (
        model.id.toLowerCase().includes(normalizedFamily)
        || model.label.toLowerCase().includes(normalizedFamily)
    ))?.id
        ?? getAssistantDefaultModelId(models, fallback);
}

// Canonical Claude model options. The default is resolved by preferred family
// below, so version numbers live in fallback metadata rather than selection logic.
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

export const CLAUDE_ASSISTANT_DEFAULT_MODEL = getAssistantPreferredModelId(
    CLAUDE_ASSISTANT_MODELS,
    'opus',
);

export const CODEX_ASSISTANT_FALLBACK_MODELS = [
    {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        reasoningEfforts: createAssistantEffortOptions(CODEX_ASSISTANT_EFFORTS, 'medium'),
        defaultReasoningEffort: 'medium',
        serviceTiers: [
            {
                id: 'fast',
                label: 'Fast',
                isDefault: true,
            },
            {
                id: 'standard',
                label: 'Standard',
            },
        ],
        defaultServiceTier: 'fast',
    },
    {
        id: 'gpt-5.4',
        label: 'GPT-5.4',
        reasoningEfforts: createAssistantEffortOptions(CODEX_ASSISTANT_EFFORTS, 'medium'),
        defaultReasoningEffort: 'medium',
        serviceTiers: [
            {
                id: 'fast',
                label: 'Fast',
                isDefault: true,
            },
            {
                id: 'standard',
                label: 'Standard',
            },
        ],
        defaultServiceTier: 'fast',
    },
    {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4-Mini',
        reasoningEfforts: createAssistantEffortOptions(CODEX_ASSISTANT_EFFORTS, 'medium'),
        defaultReasoningEffort: 'medium',
    },
    {
        id: 'gpt-5.3-codex-spark',
        label: 'GPT-5.3-Codex-Spark',
        reasoningEfforts: createAssistantEffortOptions(CODEX_ASSISTANT_EFFORTS, 'high'),
        defaultReasoningEffort: 'high',
    },
] as const satisfies readonly IAgentAssistantModelOption[];

export const CODEX_ASSISTANT_DEFAULT_MODEL = getAssistantDefaultModelId(CODEX_ASSISTANT_FALLBACK_MODELS);
