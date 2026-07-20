import {
    describe,
    expect,
    it,
} from 'vitest';
import {estimateScanCleanupOutputPages} from '@contracts/scanCleanupPageOverrides';
import {applyScanCleanupDetectionResults} from '@app/modules/scan-cleanup/runtime/applyScanCleanupDetectionResults';

describe('scan cleanup detection results', () => {
    it('fills the same classification and confidence maps used by previews', () => {
        const classifications = new Map();
        const confidences = new Map();
        applyScanCleanupDetectionResults([
            {
                pageNumber: 1,
                classification: 'two-page-spread',
                confidence: 0.82,
                cutterX: 740,
            },
            {
                pageNumber: 2,
                classification: 'single-uncut-page',
                confidence: 0.94,
                cutterX: null,
            },
        ], classifications, confidences);

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
                    rotation: 0,
                    layoutOverride: 'spread',
                    excluded: false,
                    manualSplitX: null,
                },
                '4': {
                    rotation: 0,
                    layoutOverride: 'auto',
                    excluded: true,
                    manualSplitX: null,
                },
            },
        }, classifications)).toEqual({
            exact: true,
            outputPages: 5,
        });
    });
});
