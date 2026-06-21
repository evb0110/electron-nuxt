import {
    describe,
    expect,
    it,
} from 'vitest';
import { normalizeAnalyticsScalar } from '@contracts/analytics';

describe('normalizeAnalyticsScalar', () => {
    it('truncates strings to the configured length while preserving empty strings', () => {
        expect(normalizeAnalyticsScalar('abcdef', {
            maxStringLength: 3,
            nonFiniteFallback: undefined,
        })).toBe('abc');
        expect(normalizeAnalyticsScalar('', {
            maxStringLength: 3,
            nonFiniteFallback: undefined,
        })).toBe('');
    });

    it.each([
        [true],
        [false],
        [null],
        [42],
        [-1.5],
    ])('preserves scalar value %s', value => {
        expect(normalizeAnalyticsScalar(value, {
            maxStringLength: 8,
            nonFiniteFallback: null,
        })).toBe(value);
    });

    it.each([
        [Number.NaN],
        [Number.POSITIVE_INFINITY],
        [Number.NEGATIVE_INFINITY],
    ])('uses fallback for non-finite number %s', value => {
        expect(normalizeAnalyticsScalar(value, {
            maxStringLength: 8,
            nonFiniteFallback: null,
        })).toBeNull();
        expect(normalizeAnalyticsScalar(value, {
            maxStringLength: 8,
            nonFiniteFallback: undefined,
        })).toBeUndefined();
    });

    it.each([
        [{}],
        [[]],
        [() => undefined],
        [undefined],
    ])('rejects non-scalar value %s', value => {
        expect(normalizeAnalyticsScalar(value, {
            maxStringLength: 8,
            nonFiniteFallback: null,
        })).toBeUndefined();
    });
});
