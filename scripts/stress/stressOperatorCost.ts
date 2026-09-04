import type { IStressUsageRecord } from '@scripts/stress/stressTypes';

export interface IStressModelPricing {
    inputPerMTok: number;
    outputPerMTok: number;
}

/**
 * USD per million tokens as published on 2026-09-04. Cache reads bill at 10%
 * of input, cache writes at 125%. Unknown models produce a null cost rather
 * than a guess so the budget guard degrades to turn/time limits only.
 */
export const STRESS_MODEL_PRICING: Record<string, IStressModelPricing> = {
    'claude-sonnet-5': {
        inputPerMTok: 2,
        outputPerMTok: 10,
    },
    'claude-haiku-4-5-20251001': {
        inputPerMTok: 1,
        outputPerMTok: 5,
    },
    'claude-opus-5': {
        inputPerMTok: 5,
        outputPerMTok: 25,
    },
    'claude-fable-5-1': {
        inputPerMTok: 10,
        outputPerMTok: 50,
    },
};

export const DEFAULT_STRESS_OPERATOR_MODEL = 'claude-sonnet-5';

/** Haiku 4.5 has no computer-use support, so it can only drive the semantic profile. */
export const MODELS_WITHOUT_COMPUTER_USE = new Set(['claude-haiku-4-5-20251001']);

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export function resolveStressModelPricing(model: string) {
    return STRESS_MODEL_PRICING[model] ?? null;
}

export interface IStressUsageLike {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
}

export function estimateUsageCostUsd(model: string, usage: IStressUsageLike) {
    const pricing = resolveStressModelPricing(model);
    if (!pricing) {
        return null;
    }
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const inputCost = (usage.input_tokens * pricing.inputPerMTok
        + cacheRead * pricing.inputPerMTok * CACHE_READ_MULTIPLIER
        + cacheWrite * pricing.inputPerMTok * CACHE_WRITE_MULTIPLIER) / 1_000_000;
    const outputCost = usage.output_tokens * pricing.outputPerMTok / 1_000_000;
    return inputCost + outputCost;
}

export function toStressUsageRecord(model: string, usage: IStressUsageLike): IStressUsageRecord {
    return {
        model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        costUsd: estimateUsageCostUsd(model, usage),
    };
}

export interface IStressCostLedger {
    add: (usage: IStressUsageRecord) => void;
    totalUsd: () => number;
    totalKnown: () => boolean;
    records: () => IStressUsageRecord[];
}

/**
 * Sums per-turn usage. `totalKnown` flips false as soon as one record has no
 * price so the caller can tell "cheap" from "unpriced".
 */
export function createStressCostLedger(): IStressCostLedger {
    const records: IStressUsageRecord[] = [];
    let total = 0;
    let known = true;
    return {
        add(usage) {
            records.push(usage);
            if (usage.costUsd === null) {
                known = false;
            } else {
                total += usage.costUsd;
            }
        },
        totalUsd: () => total,
        totalKnown: () => known,
        records: () => [...records],
    };
}
