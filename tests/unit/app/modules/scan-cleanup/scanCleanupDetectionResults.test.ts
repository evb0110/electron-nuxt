import {
    describe,
    expect,
    it,
} from 'vitest';
import {estimateScanCleanupOutputPages} from '@contracts/scanCleanupPageOverrides';
import {applyScanCleanupDetectionResults} from '@app/modules/scan-cleanup/runtime/applyScanCleanupDetectionResults';

describe('scan cleanup detection results', () => {
    it('fills the detected classification and confidence stores', () => {
        const classifications = new Map();
        const confidences = new Map();
        const documentPriors = new Map();
        const textAxes = new Map([[
            2,
            {
                sideways: true,
                confidence: 0.8,
            },
        ]]);
        applyScanCleanupDetectionResults([
            {
                pageNumber: 1,
                classification: 'two-page-spread',
                confidence: 0.82,
                cutterXPx: 740,
                tier1Verdict: 'single-uncut-page',
                reconciled: true,
                clusterAgreement: 0.84,
                documentPrior: {
                    dominantLayout: 'two-page-spread',
                    cutterRatioMedian: 0.52,
                    clusterDims: {
                        widthPx: 1400,
                        heightPx: 1000,
                    },
                    agreementStrength: 0.84,
                },
                textAxis: {
                    sideways: true,
                    confidence: 0.97,
                },
            },
            {
                pageNumber: 2,
                classification: 'single-uncut-page',
                confidence: 0.94,
                cutterXPx: null,
                tier1Verdict: 'single-uncut-page',
                reconciled: false,
                clusterAgreement: 0,
                documentPrior: null,
            },
        ], classifications, confidences, undefined, documentPriors, textAxes);

        expect([...classifications]).toEqual([
            [
                1,
                'two-page-spread',
            ],
            [
                2,
                'single-uncut-page',
            ],
        ]);
        expect([...confidences]).toEqual([
            [
                1,
                0.82,
            ],
            [
                2,
                0.94,
            ],
        ]);
        expect(documentPriors.get(1)).toMatchObject({
            dominantLayout: 'two-page-spread',
            agreementStrength: 0.84,
        });
        expect(documentPriors.has(2)).toBe(false);
        expect(textAxes.get(1)).toEqual({
            sideways: true,
            confidence: 0.97,
        });
        expect(textAxes.has(2)).toBe(false);
    });

    it('produces an exact estimate with detected layouts, overrides, and exclusions', () => {
        const classifications = new Map([
            [
                1,
                'two-page-spread' as const,
            ],
            [
                2,
                'single-uncut-page' as const,
            ],
            [
                3,
                'single-uncut-page' as const,
            ],
            [
                4,
                'two-page-spread' as const,
            ],
        ]);

        expect(estimateScanCleanupOutputPages(4, {
            layoutMode: 'auto',
            pageOverrides: {
                '2': {
                    rotationDegrees: 0,
                    layoutOverride: 'spread',
                    excluded: false,
                    manualSplit: null,
                },
                '4': {
                    rotationDegrees: 0,
                    layoutOverride: 'auto',
                    excluded: true,
                    manualSplit: null,
                },
            },
        }, classifications)).toEqual({
            exact: true,
            outputPages: 5,
        });
    });
});
