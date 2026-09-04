import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    DEFAULT_STRESS_OPERATOR_MODEL,
    MODELS_WITHOUT_COMPUTER_USE,
    createStressCostLedger,
    estimateUsageCostUsd,
    resolveStressModelPricing,
    toStressUsageRecord,
} from '@scripts/stress/stressOperatorCost';

describe('stress operator cost', () => {
    it('prices the default model and knows Haiku cannot drive computer use', () => {
        expect(resolveStressModelPricing(DEFAULT_STRESS_OPERATOR_MODEL)).not.toBeNull();
        expect(MODELS_WITHOUT_COMPUTER_USE.has('claude-haiku-4-5-20251001')).toBe(true);
        expect(MODELS_WITHOUT_COMPUTER_USE.has(DEFAULT_STRESS_OPERATOR_MODEL)).toBe(false);
    });

    it('applies cache read and write multipliers', () => {
        const cost = estimateUsageCostUsd('claude-sonnet-5', {
            input_tokens: 1_000_000,
            output_tokens: 100_000,
            cache_read_input_tokens: 1_000_000,
            cache_creation_input_tokens: 1_000_000,
        });
        expect(cost).toBeCloseTo(2 + 1 + 0.2 + 2.5, 6);
    });

    it('returns null for an unpriced model so the guard degrades honestly', () => {
        expect(estimateUsageCostUsd('claude-future-9', {
            input_tokens: 10,
            output_tokens: 10,
        })).toBeNull();
        const record = toStressUsageRecord('claude-future-9', {
            input_tokens: 10,
            output_tokens: 10,
        });
        expect(record.costUsd).toBeNull();
        expect(record.cacheReadTokens).toBe(0);
    });

    it('sums a ledger and flips totalKnown when any record is unpriced', () => {
        const ledger = createStressCostLedger();
        ledger.add(toStressUsageRecord('claude-sonnet-5', {
            input_tokens: 500_000,
            output_tokens: 0,
        }));
        expect(ledger.totalUsd()).toBeCloseTo(1, 6);
        expect(ledger.totalKnown()).toBe(true);
        ledger.add(toStressUsageRecord('claude-future-9', {
            input_tokens: 1,
            output_tokens: 1,
        }));
        expect(ledger.totalKnown()).toBe(false);
        expect(ledger.records()).toHaveLength(2);
    });
});
