import type {
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentMcpIntegrationStatus,
    IAgentMcpIntegrationUpdateResult,
    IAgentWorkspaceSnapshotRequest,
    IAgentWorkspaceSnapshotResponse,
} from '@contracts/agent';
import type { IMenuEventUnsubscribe } from '@contracts/electronApiCommon';

export interface IAgentCapability {
    onWorkspaceSnapshotRequest: (
        callback: (request: IAgentWorkspaceSnapshotRequest) => void,
    ) => IMenuEventUnsubscribe;
    submitWorkspaceSnapshot: (response: IAgentWorkspaceSnapshotResponse) => Promise<boolean>;
    onCommandRequest: (
        callback: (request: IAgentCommandRequest) => void,
    ) => IMenuEventUnsubscribe;
    submitCommandResponse: (response: IAgentCommandResponse) => Promise<boolean>;
    getMcpIntegrationStatus: () => Promise<IAgentMcpIntegrationStatus>;
    setMcpIntegrationEnabled: (enabled: boolean) => Promise<IAgentMcpIntegrationUpdateResult>;
}
