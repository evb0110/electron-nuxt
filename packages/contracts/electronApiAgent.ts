import type {
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentAssistantEvent,
    IAgentAssistantInstallResult,
    IAgentAssistantLoginRequest,
    IAgentAssistantLoginResult,
    IAgentAssistantScopedRequest,
    IAgentAssistantSendMessageRequest,
    IAgentAssistantSendMessageResult,
    IAgentAssistantState,
    IAgentAssistantStateRequest,
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
    getAssistantState: (request?: IAgentAssistantStateRequest) => Promise<IAgentAssistantState>;
    installAssistantCodex: () => Promise<IAgentAssistantInstallResult>;
    startAssistantLogin: (request: IAgentAssistantLoginRequest) => Promise<IAgentAssistantLoginResult>;
    cancelAssistantLogin: () => Promise<IAgentAssistantState>;
    sendAssistantMessage: (request: IAgentAssistantSendMessageRequest) => Promise<IAgentAssistantSendMessageResult>;
    interruptAssistant: (request?: IAgentAssistantScopedRequest) => Promise<IAgentAssistantState>;
    resetAssistantChat: (request?: IAgentAssistantScopedRequest) => Promise<IAgentAssistantState>;
    onAssistantEvent: (
        callback: (event: IAgentAssistantEvent) => void,
    ) => IMenuEventUnsubscribe;
}
