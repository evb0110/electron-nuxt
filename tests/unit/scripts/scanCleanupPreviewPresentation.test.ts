import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    compareDisplayedPreviewLeaves,
    createPreviewPresentationStabilityReport,
} from '@scripts/diagnostics/scan-cleanup-preview-presentation.mjs';

const stableComparison = {
    half: 'left',
    rasterIdentical: true,
    inkMarginShift: {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        maximum: 0,
    },
};

function report(
    postWindowComparisons: object[],
    leafSets: {
        previewHalves?: string[],
        provisionalHalves?: string[],
    } = {},
) {
    return createPreviewPresentationStabilityReport({
        earlyCommit: {action: 'coalesce'},
        earlySettleComparisons: [stableComparison],
        graceWindowMs: 2_000,
        settleCommitComparisons: [stableComparison],
        postWindowCommit: {action: 'reject'},
        postWindowComparisons,
        ...leafSets,
        secondAutomaticCommit: {action: 'coalesce'},
        secondAutomaticComparisons: [stableComparison],
    });
}

describe('scan cleanup preview presentation evidence', () => {
    it('gates any post-window movement', () => {
        const rasterOnly = {
            ...stableComparison,
            rasterIdentical: false,
        };
        const marginOnly = {
            ...stableComparison,
            inkMarginShift: {
                ...stableComparison.inkMarginShift,
                maximum: 0.001,
            },
        };

        expect(report([stableComparison]).violations).toEqual([]);
        expect(report([rasterOnly]).violations).toContain('presentation-post-window-movement');
        expect(report([marginOnly]).violations).toContain('presentation-post-window-movement');
    });

    it('reports either missing comparison half instead of silently skipping it', async () => {
        const measureMargins = vi.fn();
        const compareMargins = vi.fn();
        const beforeMissing = await compareDisplayedPreviewLeaves([], [{
            half: 'right',
            metricsPath: '/unused-after.png',
        }], measureMargins, compareMargins);
        const afterMissing = await compareDisplayedPreviewLeaves([{
            half: 'left',
            metricsPath: '/unused-before.png',
        }], [], measureMargins, compareMargins);

        expect(beforeMissing).toEqual([expect.objectContaining({
            half: 'right',
            missingBefore: true,
        })]);
        expect(afterMissing).toEqual([expect.objectContaining({
            half: 'left',
            missingAfter: true,
        })]);
        expect(report(beforeMissing).violations).toEqual(expect.arrayContaining([
            'presentation-missing-half',
            'presentation-post-window-movement',
        ]));
        expect(measureMargins).not.toHaveBeenCalled();
        expect(compareMargins).not.toHaveBeenCalled();
    });

    it('checks both provisional and post-window candidate leaf sets for a dropped half', () => {
        expect(report([stableComparison], {
            provisionalHalves: [
                'left',
                'right',
            ],
            previewHalves: ['left'],
        }).violations).toContain('presentation-missing-half');
        expect(report([stableComparison], {
            provisionalHalves: ['left'],
            previewHalves: [
                'left',
                'right',
            ],
        }).violations).toContain('presentation-missing-half');
    });
});
