export type TAgentOcrPageRange = 'all' | 'current' | 'custom';

export interface IAgentOcrRunOptions {
    pageRange?: TAgentOcrPageRange;
    customRange?: string;
    languages?: string[];
    open?: boolean;
}

export interface IOcrPopupAgentExpose {
    runOcrForAgent: (options?: IAgentOcrRunOptions) => Promise<Record<string, unknown>>;
    cancelOcrForAgent: () => Record<string, unknown>;
    getAgentOcrSnapshot: () => Record<string, unknown>;
}
