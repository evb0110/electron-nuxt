import {
    describe,
    expect,
    it,
} from 'vitest';
import type { TTranslateFn } from '@i18n-app';
import { formatPdfSearchResultsSummary } from '@app/modules/pdf-viewer/search/formatPdfSearchResultsSummary';

const t: TTranslateFn = (key, ...args) => {
    const params = args[0];
    if (key === 'searchResults.searching') {
        return 'Searching...';
    }
    if (key === 'searchResults.resultCount') {
        return `${typeof params === 'object' && params && 'count' in params ? params.count : 0} results`;
    }
    if (key === 'searchResults.forQuery') {
        return `for "${typeof params === 'object' && params && 'query' in params ? params.query : ''}"`;
    }
    return key;
};

describe('formatPdfSearchResultsSummary', () => {
    it('uses a stable searching label for active searches with no streamed matches yet', () => {
        expect(formatPdfSearchResultsSummary({
            isSearching: true,
            query: 'редац',
            resultCount: 0,
            t,
        })).toBe('Searching...');
    });

    it('uses the result count once matches exist or the search has completed', () => {
        expect(formatPdfSearchResultsSummary({
            isSearching: true,
            query: 'редац',
            resultCount: 3,
            t,
        })).toBe('3 results for "редац"');

        expect(formatPdfSearchResultsSummary({
            isSearching: false,
            query: 'редац',
            resultCount: 0,
            t,
        })).toBe('0 results for "редац"');
    });
});
