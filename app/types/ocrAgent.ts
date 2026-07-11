import type {
    TOcrPreprocessingMode,
    TOcrQualityProfile,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';

export type {
    TOcrPreprocessingMode,
    TOcrQualityProfile,
} from '@contracts/electronApiOcr';

export type TAgentOcrPageRange = 'all' | 'current' | 'custom';

export interface IAgentOcrRunOptions {
    pageRange?: TAgentOcrPageRange;
    customRange?: string;
    languages?: string[];
    qualityProfile?: TOcrQualityProfile;
    preprocessingMode?: TOcrPreprocessingMode;
    pageSegmentationMode?: number;
    supersessionPolicy?: TOcrTextSupersessionPolicy;
    replaceAllAcknowledged?: boolean;
    open?: boolean;
}

export interface IOcrPopupAgentExpose {
    runOcrForAgent: (options?: IAgentOcrRunOptions) => Promise<Record<string, unknown>>;
    cancelOcrForAgent: () => Promise<Record<string, unknown>>;
    getAgentOcrSnapshot: () => Record<string, unknown>;
}
