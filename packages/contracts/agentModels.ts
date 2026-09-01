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

// Keep the picker on the current GPT generation while allowing non-versioned
// custom model slugs through unchanged.
const CODEX_MINIMUM_GPT_MODEL = {
    major: 5,
    minor: 6,
} as const;
const CODEX_GPT_MODEL_VERSION_PATTERN = /^gpt-(\d+)(?:\.(\d+))?(?=[^0-9]|$)/u;

export function isRemovedCodexAssistantModelId(model: string) {
    const match = CODEX_GPT_MODEL_VERSION_PATTERN.exec(model.trim().toLowerCase());
    if (!match) {
        return false;
    }

    const major = Number(match[1]);
    const minor = Number(match[2] ?? 0);
    return major < CODEX_MINIMUM_GPT_MODEL.major
        || (major === CODEX_MINIMUM_GPT_MODEL.major && minor < CODEX_MINIMUM_GPT_MODEL.minor);
}

// Canonical Claude model options. The default is resolved by preferred family
// below, so version numbers live in fallback metadata rather than selection logic.
export const CLAUDE_ASSISTANT_MODELS = [
    {
        id: 'fable',
        label: 'Claude Fable 5.1',
    },
    {
        id: 'opus',
        label: 'Claude Opus 5',
    },
    {
        id: 'sonnet',
        label: 'Claude Sonnet 5',
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

export const CODEX_ASSISTANT_FALLBACK_MODELS = [{
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6-Sol',
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
}] as const satisfies readonly IAgentAssistantModelOption[];

export const CODEX_ASSISTANT_DEFAULT_MODEL = getAssistantDefaultModelId(CODEX_ASSISTANT_FALLBACK_MODELS);
