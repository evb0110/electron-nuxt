import type { TOcrQualityProfile } from '@contracts/electronApiOcr';

export type { TOcrQualityProfile } from '@contracts/electronApiOcr';

export type TAgentOcrPageRange = 'all' | 'current' | 'custom';

export interface IAgentOcrRunOptions {
    pageRange?: TAgentOcrPageRange;
    customRange?: string;
    languages?: string[];
    qualityProfile?: TOcrQualityProfile;
    open?: boolean;
}

export interface IOcrPopupAgentExpose {
    runOcrForAgent: (options?: IAgentOcrRunOptions) => Promise<Record<string, unknown>>;
    cancelOcrForAgent: () => Record<string, unknown>;
    getAgentOcrSnapshot: () => Record<string, unknown>;
}
