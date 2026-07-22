export type TScanCleanupProgressStage =
    | 'queued'
    | 'normalizing'
    | 'rasterizing'
    | 'cleaning'
    | 'assembling'
    | 'handoff'
    | 'detecting';

export interface IScanCleanupProgress {
    stage: TScanCleanupProgressStage;
    completedUnits: number;
    totalUnits: number;
    percent: number;
    /** Exact one-based source pages completed so concurrent work never produces inferred ticks. */
    completedPageNumbers?: number[];
}
