import {
    runtimeSchema,
    type TInferSchema,
} from '@contracts/platformFeature';

const s = runtimeSchema;
const progress = s.refine(s.object({
    stage: s.oneOf([
        'queued',
        'normalizing',
        'probing',
        'extracting',
        'rasterizing',
        'classifying',
        'rendering',
        'collecting',
        'assembling',
        'handoff',
        'detecting',
    ] as const, 'invalid scan-cleanup progress'),
    completedUnits: s.number({
        integer: true,
        min: 0,
        message: 'invalid scan-cleanup progress',
    }),
    totalUnits: s.number({
        integer: true,
        min: 0,
        message: 'invalid scan-cleanup progress',
    }),
    percent: s.number({
        min: 0,
        max: 100,
        message: 'invalid scan-cleanup progress',
    }),
    etaSeconds: s.optional(s.number({
        integer: true,
        min: 0,
        message: 'invalid scan-cleanup progress ETA',
    })),
    completedPageNumbers: s.optional(s.array(s.number({
        integer: true,
        min: 1,
        message: 'invalid scan-cleanup completed page numbers',
    }))),
}), value =>
    value.completedUnits <= value.totalUnits
    && (
        value.completedPageNumbers === undefined
        || (
            value.completedPageNumbers.length === value.completedUnits
            && new Set(value.completedPageNumbers).size === value.completedPageNumbers.length
        )
    ),
'invalid scan-cleanup progress');

export const SCAN_CLEANUP_PROGRESS_SCHEMA = progress;
export type TScanCleanupProgress = TInferSchema<typeof progress>;
export type TScanCleanupProgressStage = TScanCleanupProgress['stage'];
