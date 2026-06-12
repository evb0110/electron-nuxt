import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdf';
import { buildVisualMatchesWithCurrent } from '@app/modules/pdf-viewer/engine/search/buildVisualMatchesWithCurrent';

describe('usePdfSearchHighlight', () => {
    it('remaps stale backend offsets to the rendered text layer', () => {
        const pageMatches: IPdfPageMatches = {
            pageIndex: 0,
            pageText: '',
            searchQuery: 'alpha',
            searchOptions: {
                matchCase: false,
                wholeWord: false,
                useRegex: false,
            },
            matches: [
                {
                    matchIndex: 0,
                    start: 6,
                    end: 11,
                },
                {
                    matchIndex: 1,
                    start: 0,
                    end: 5,
                },
            ],
        };
        const currentMatch: IPdfSearchMatch = {
            pageIndex: 0,
            pageMatchIndex: 1,
            matchIndex: 1,
            startOffset: 0,
            endOffset: 5,
        };

        const result = buildVisualMatchesWithCurrent(pageMatches, currentMatch, 'alpha beta alpha');

        expect(result).toEqual([
            {
                start: 0,
                end: 5,
                isCurrent: false,
            },
            {
                start: 11,
                end: 16,
                isCurrent: true,
            },
        ]);
    });

    it('keeps compatible backend offsets instead of adding extra local matches', () => {
        const pageMatches: IPdfPageMatches = {
            pageIndex: 0,
            pageText: '',
            searchQuery: 'alpha',
            matches: [{
                matchIndex: 0,
                start: 0,
                end: 5,
            }],
        };

        const result = buildVisualMatchesWithCurrent(pageMatches, null, 'alpha beta alpha');

        expect(result).toEqual([{
            start: 0,
            end: 5,
            isCurrent: false,
        }]);
    });
});
