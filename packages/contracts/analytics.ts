import type { TAnalyticsPayloadValue } from '../../app/types/analytics';

export interface INormalizeAnalyticsScalarOptions {
    maxStringLength: number;
    nonFiniteFallback: TAnalyticsPayloadValue | undefined;
}

export type TAnalyticsScalarResult = TAnalyticsPayloadValue | undefined;

export function normalizeAnalyticsScalar(
    value: unknown,
    options: INormalizeAnalyticsScalarOptions,
): TAnalyticsScalarResult {
    if (value === null) {
        return null;
    }
    if (typeof value === 'string') {
        return value.slice(0, options.maxStringLength);
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : options.nonFiniteFallback;
    }
    return undefined;
}
