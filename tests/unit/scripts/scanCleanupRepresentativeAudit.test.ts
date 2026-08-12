import {
    alignBitmapForComparison,
    buildExpectationInfos,
    buildExpectedMapping,
} from '@scripts/diagnostics/scan-cleanup-representative-audit.mjs';
import {
    describe,
    expect,
    it,
} from 'vitest';

function makeSyntheticBitmap(offsetX = 0, includeContent = true) {
    const width = 160;
    const height = 224;
    const data = new Uint8Array(width * height).fill(255);
    const rectangles = includeContent
        ? [
            {
                bottom: 64,
                left: 16,
                right: 48,
                top: 24,
            },
            {
                bottom: 128,
                left: 72,
                right: 120,
                top: 88,
            },
            {
                bottom: 200,
                left: 40,
                right: 88,
                top: 160,
            },
        ]
        : [];
    for (const {
        bottom,
        left,
        right,
        top,
    } of rectangles) {
        for (let y = top; y < bottom; y += 1) {
            for (let x = left + offsetX; x < right + offsetX; x += 1) {
                if (x >= 0 && x < width) {
                    data[y * width + x] = 0;
                }
            }
        }
    }
    return {
        data,
        height,
        width,
    };
}

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

    it('aligns bounded placement shifts and rejects a no-overlap candidate', () => {
        const source = makeSyntheticBitmap();
        const shifted = alignBitmapForComparison(source, makeSyntheticBitmap(16));

        expect(shifted.metrics).toMatchObject({
            applied: true,
            bestOverlap: 1,
            rejected: false,
        });
        expect(shifted.metrics.bestSimilarity).toBeGreaterThan(0.8);
        expect(shifted.metrics.offsetPixels.x).toBeLessThan(0);
        expect(Math.abs(shifted.metrics.offsetPixels.x)).toBeLessThanOrEqual(24);
        expect(shifted.metrics.offsetPixels.y).toBe(0);

        const lost = alignBitmapForComparison(source, makeSyntheticBitmap(0, false));
        expect(lost.metrics).toMatchObject({
            applied: false,
            bestOverlap: 0,
            rejected: true,
        });
        expect(lost.metrics.appliedOffsetPixels).toEqual({
            x: 0,
            y: 0,
        });
    });
});
