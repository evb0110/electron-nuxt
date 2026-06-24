import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    ANALYTICS_GEO_LIMITS,
    normalizeAnalyticsGeo,
    normalizeAnalyticsScalar,
} from '@contracts/analytics';

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

describe('normalizeAnalyticsGeo', () => {
    it('validates countries and truncates bounded geo headers', () => {
        const geo = normalizeAnalyticsGeo({
            country: ' us ',
            region: `CA-${'x'.repeat(80)}`,
            city: `San Francisco ${'x'.repeat(400)}`,
            timezone: `America/Los_Angeles-${'x'.repeat(100)}`,
        });

        expect(geo.country).toBe('US');
        expect(geo.region).toHaveLength(ANALYTICS_GEO_LIMITS.region);
        expect(geo.city).toHaveLength(ANALYTICS_GEO_LIMITS.city);
        expect(geo.timezone).toHaveLength(ANALYTICS_GEO_LIMITS.timezone);
    });

    it.each([
        [null],
        [''],
        ['u'],
        ['usa'],
        ['1!'],
    ])('drops invalid country header %s without dropping the rest of the geo data', country => {
        expect(normalizeAnalyticsGeo({
            country,
            city: 'Paris',
            region: 'IDF',
        })).toEqual({
            country: null,
            city: 'Paris',
            region: 'IDF',
            timezone: null,
        });
    });
});
