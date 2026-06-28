import type { IAgentCapability } from '@contracts/agentCapability';
import { getPlatformAPI } from '@app/utils/platform';

export function getAgentCapability(): IAgentCapability {
    return getPlatformAPI().agent;
}
