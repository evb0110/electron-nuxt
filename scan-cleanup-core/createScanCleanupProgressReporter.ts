import type {
    TScanCleanupProgress,
    TScanCleanupProgressStage,
    TScanCleanupSummary,
} from '@contracts/electronApiScanCleanup';

type TStageWeights = ReadonlyArray<readonly [TScanCleanupProgressStage, number]>;

export type TEmitScanCleanupProgress = (
    stage: TScanCleanupProgressStage,
    completedUnits: number,
    totalUnits: number,
    completedPageNumbers?: Iterable<number>,
) => void;

export function createEmptyScanCleanupSummary(
    inputPages: number,
    warnings: readonly string[],
): TScanCleanupSummary {
    return {
        inputPages,
        outputPages: 0,
        spreadsSplit: 0,
        offcutsDiscarded: 0,
        deskewSkipped: 0,
        cropSkipped: 0,
        excludedPages: 0,
        blankPagesSkipped: 0,
        warnings: [...warnings],
    };
}

// Shares observed on the 392-page reference scan once the sidecar stopped
// classifying every page in a discarded pass: rasterizing 18.5 %, rendering
// 66.9 %, assembling 10.8 %, everything else under 4 % each.
const RASTER_STAGE_WEIGHTS = [
    [
        'normalizing',
        1,
    ],
    [
        'probing',
        4,
    ],
    [
        'extracting',
        4,
    ],
    [
        'rasterizing',
        17,
    ],
    [
        'rendering',
        58,
    ],
    [
        'collecting',
        2,
    ],
    [
        'assembling',
        12,
    ],
    [
        'handoff',
        2,
    ],
] as const satisfies TStageWeights;

const LOSSLESS_STAGE_WEIGHTS = [
    [
        'normalizing',
        3,
    ],
    [
        'probing',
        4,
    ],
    [
        'extracting',
        0,
    ],
    [
        'rasterizing',
        40,
    ],
    [
        'classifying',
        33,
    ],
    [
        'collecting',
        5,
    ],
    [
        'assembling',
        13,
    ],
    [
        'handoff',
        2,
    ],
] as const satisfies TStageWeights;

function resolveBands(weights: TStageWeights) {
    const totalWeight = weights.reduce((sum, [
        , weight,
    ]) => sum + weight, 0);
    const bands = new Map<TScanCleanupProgressStage, {
        start: number;
        span: number
    }>();
    let consumedWeight = 0;
    for (const [
        stage,
        weight,
    ] of weights) {
        bands.set(stage, {
            start: consumedWeight / totalWeight * 100,
            span: weight / totalWeight * 100,
        });
        consumedWeight += weight;
    }
    return bands;
}

// Both profiles are fixed tables, so they are laid out once rather than on
// every progress report a run emits.
const RASTER_BANDS = resolveBands(RASTER_STAGE_WEIGHTS);
const LOSSLESS_BANDS = resolveBands(LOSSLESS_STAGE_WEIGHTS);

/**
 * `isLossless` is read per report rather than captured: a matched run that
 * cannot keep a page's own pixels starts on the lossless profile and then
 * renders, and a profile fixed at the first report would leave the meter frozen
 * through the longest stage of the run it actually performed. The percentage
 * only ever moves forward, so the switch can hold it but never rewind it.
 */
export function createScanCleanupProgressReporter(
    callback: (progress: TScanCleanupProgress) => void,
    isLossless: () => boolean,
): TEmitScanCleanupProgress {
    let lastPercent = 0;
    return (stage, completedUnits, totalUnits, completedPageNumbers) => {
        const band = (isLossless() ? LOSSLESS_BANDS : RASTER_BANDS).get(stage);
        const fraction = totalUnits > 0 ? Math.min(1, completedUnits / totalUnits) : 0;
        const percent = band === undefined ? lastPercent : band.start + (band.span * fraction);
        lastPercent = Math.min(100, Math.max(lastPercent, percent));
        callback({
            stage,
            completedUnits,
            totalUnits,
            percent: lastPercent,
            ...(completedPageNumbers ? {completedPageNumbers: [...completedPageNumbers]} : {}),
        });
    };
}
