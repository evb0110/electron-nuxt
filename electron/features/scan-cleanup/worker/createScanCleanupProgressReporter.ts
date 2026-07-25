import type {
    TScanCleanupProgress,
    TScanCleanupProgressStage,
} from '@contracts/electronApiScanCleanup';

type TStageWeights = ReadonlyArray<readonly [TScanCleanupProgressStage, number]>;

export type TEmitScanCleanupProgress = (
    stage: TScanCleanupProgressStage,
    completedUnits: number,
    totalUnits: number,
    completedPageNumbers?: Iterable<number>,
) => void;

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
        'rasterizing',
        19,
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
        14,
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

export function createScanCleanupProgressReporter(
    callback: (progress: TScanCleanupProgress) => void,
    preserveOriginalQuality: boolean,
): TEmitScanCleanupProgress {
    const weights: TStageWeights = preserveOriginalQuality ? LOSSLESS_STAGE_WEIGHTS : RASTER_STAGE_WEIGHTS;
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

    let lastPercent = 0;
    return (stage, completedUnits, totalUnits, completedPageNumbers) => {
        const band = bands.get(stage);
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
