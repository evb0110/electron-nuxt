import type {IAgentOcrRunOptions} from '@contracts/agentOcr';

export interface IOcrPopupAgentExpose {
    runOcrForAgent: (options?: IAgentOcrRunOptions) => Promise<Record<string, unknown>>;
    cancelOcrForAgent: () => Promise<Record<string, unknown>>;
    getAgentOcrSnapshot: () => Record<string, unknown>;
}
