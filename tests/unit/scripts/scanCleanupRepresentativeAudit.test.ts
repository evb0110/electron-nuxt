import {
    buildExpectationInfos,
    buildExpectedMapping,
} from '@scripts/diagnostics/scan-cleanup-representative-audit.mjs';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('scan cleanup representative audit mapping inference', () => {
    it('uses rendered output count to choose whole-page versus split mapping', () => {
        const wholePage = buildExpectedMapping(1, 1);
        expect(wholePage.entries).toEqual([{
            cleanedPage: 1,
            side: 'whole',
            sourcePage: 1,
            sourceLayout: 'single',
        }]);
        expect(buildExpectationInfos({
            expectSingles: new Set<number>(),
            inferredLayouts: wholePage.inferredLayouts,
        })).toMatchObject([{code: 'expectation-mismatch'}]);
        expect(buildExpectationInfos({
            expectSingles: new Set([1]),
            inferredLayouts: wholePage.inferredLayouts,
        })).toEqual([]);

        const splitPage = buildExpectedMapping(1, 2);
        expect(splitPage.entries).toEqual([
            {
                cleanedPage: 1,
                side: 'left',
                sourcePage: 1,
                sourceLayout: 'spread',
            },
            {
                cleanedPage: 2,
                side: 'right',
                sourcePage: 1,
                sourceLayout: 'spread',
            },
        ]);

        const partialSplit = buildExpectedMapping(10, 19);
        expect(partialSplit.expectedCleanedCount).toBe(20);
        expect(partialSplit.entries.at(-1)).toMatchObject({
            cleanedPage: 20,
            side: 'right',
            sourcePage: 10,
        });
    });
});
