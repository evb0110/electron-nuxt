import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    pageIndexToPageNumber,
    pageNumberToPageIndex,
    parsePageIndex,
    parsePageNumber,
    requirePageIndex,
    requirePageNumber,
} from '@contracts/pageNumbers';

describe('page number contracts', () => {
    it.each([
        [
            0,
            3,
            0,
        ],
        [
            1,
            3,
            1,
        ],
        [
            2,
            3,
            2,
        ],
    ])('accepts valid zero-based page index %s of %s', (value, pageCount, expected) => {
        expect(parsePageIndex(value, pageCount)).toBe(expected);
    });

    it.each([
        [-1],
        [1.5],
        [Number.NaN],
        [Number.MAX_SAFE_INTEGER + 1],
    ])('rejects invalid page index %s', value => {
        expect(parsePageIndex(value)).toBeNull();
    });

    it('rejects page indexes at or beyond pageCount', () => {
        expect(parsePageIndex(3, 3)).toBeNull();
        expect(parsePageIndex(4, 3)).toBeNull();
    });

    it.each([
        [
            1,
            3,
            1,
        ],
        [
            2,
            3,
            2,
        ],
        [
            3,
            3,
            3,
        ],
    ])('accepts valid one-based page number %s of %s', (value, pageCount, expected) => {
        expect(parsePageNumber(value, pageCount)).toBe(expected);
    });

    it.each([
        [0],
        [-1],
        [1.5],
        [Number.NaN],
        [Number.MAX_SAFE_INTEGER + 1],
    ])('rejects invalid page number %s', value => {
        expect(parsePageNumber(value)).toBeNull();
    });

    it('rejects page numbers above pageCount', () => {
        expect(parsePageNumber(4, 3)).toBeNull();
    });

    it('round-trips page index and page number conversions', () => {
        expect(pageIndexToPageNumber(requirePageIndex(0))).toBe(1);
        expect(pageNumberToPageIndex(requirePageNumber(1))).toBe(0);
        expect(pageNumberToPageIndex(pageIndexToPageNumber(requirePageIndex(4)))).toBe(4);
    });
});
