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

// Non-streaming transports really do materialize the complete raster handoff
// before native rendering starts, so they retain separate bands.
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

// FIFO production and native consumption are one pipeline. Native page
// completion is its authoritative counter; presenting producer completion as
// an earlier stage made the meter stall and then jump by most of its width.
const STREAMING_RASTER_STAGE_WEIGHTS = [
    [
        'normalizing',
        1,
    ],
    [
        'probing',
        3,
    ],
    [
        'extracting',
        6,
    ],
    [
        'rendering',
        78,
    ],
    [
        'collecting',
        1,
    ],
    [
        'assembling',
        9,
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
const STREAMING_RASTER_BANDS = resolveBands(STREAMING_RASTER_STAGE_WEIGHTS);
const LOSSLESS_BANDS = resolveBands(LOSSLESS_STAGE_WEIGHTS);

const ETA_MIN_COMPLETED_UNITS = 5;
const ETA_MIN_STAGE_ELAPSED_MS = 10_000;
const ETA_EMA_ALPHA = 0.25;

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
    options: {
        isRasterStreaming?: () => boolean;
        now?: () => number
    } = {},
): TEmitScanCleanupProgress {
    const now = options.now ?? (() => performance.now());
    let lastPercent = 0;
    let activeStage: TScanCleanupProgressStage | null = null;
    let stageStartedAt = 0;
    let lastSampleAt = 0;
    let lastCompletedUnits = 0;
    let smoothedMsPerUnit: number | null = null;
    return (stage, completedUnits, totalUnits, completedPageNumbers) => {
        const reportedAt = now();
        const bands = isLossless()
            ? LOSSLESS_BANDS
            : options.isRasterStreaming?.() === true
                ? STREAMING_RASTER_BANDS
                : RASTER_BANDS;
        const band = bands.get(stage);
        const fraction = totalUnits > 0 ? Math.min(1, completedUnits / totalUnits) : 0;
        const percent = band === undefined ? lastPercent : band.start + (band.span * fraction);
        lastPercent = Math.min(100, Math.max(lastPercent, percent));
        if (activeStage !== stage || completedUnits < lastCompletedUnits) {
            activeStage = stage;
            stageStartedAt = reportedAt;
            lastSampleAt = reportedAt;
            lastCompletedUnits = completedUnits;
            smoothedMsPerUnit = null;
        } else if (completedUnits > lastCompletedUnits) {
            const sampleMsPerUnit = (reportedAt - lastSampleAt) / (completedUnits - lastCompletedUnits);
            if (Number.isFinite(sampleMsPerUnit) && sampleMsPerUnit >= 0) {
                smoothedMsPerUnit = smoothedMsPerUnit === null
                    ? sampleMsPerUnit
                    : smoothedMsPerUnit * (1 - ETA_EMA_ALPHA) + sampleMsPerUnit * ETA_EMA_ALPHA;
            }
            lastSampleAt = reportedAt;
            lastCompletedUnits = completedUnits;
        }
        let etaSeconds: number | undefined;
        if (
            band !== undefined
            && smoothedMsPerUnit !== null
            && completedUnits >= ETA_MIN_COMPLETED_UNITS
            && reportedAt - stageStartedAt >= ETA_MIN_STAGE_ELAPSED_MS
            && totalUnits > 0
            && band.span > 0
        ) {
            const remainingStageMs = Math.max(0, totalUnits - completedUnits) * smoothedMsPerUnit;
            const futurePercent = Math.max(0, 100 - band.start - band.span);
            const futureMs = totalUnits * smoothedMsPerUnit / band.span * futurePercent;
            etaSeconds = Math.max(0, Math.ceil((remainingStageMs + futureMs) / 1000));
        }
        callback({
            stage,
            completedUnits,
            totalUnits,
            percent: lastPercent,
            ...(etaSeconds === undefined ? {} : {etaSeconds}),
            ...(completedPageNumbers ? {completedPageNumbers: [...completedPageNumbers]} : {}),
        });
    };
}
