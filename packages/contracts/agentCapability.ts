import type {
    IAgentCommandCancelRequest,
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentRendererAck,
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
import type { TMenuEventUnsubscribe } from '@contracts/electronApiCommon';

export interface IAgentCapability {
    onWorkspaceSnapshotRequest: (
        callback: (request: IAgentWorkspaceSnapshotRequest) => void,
    ) => TMenuEventUnsubscribe;
    submitWorkspaceSnapshot: (response: IAgentWorkspaceSnapshotResponse) => Promise<IAgentRendererAck>;
    onCommandRequest: (
        callback: (request: IAgentCommandRequest) => void,
    ) => TMenuEventUnsubscribe;
    onCommandCancelRequest: (
        callback: (request: IAgentCommandCancelRequest) => void,
    ) => TMenuEventUnsubscribe;
    submitCommandResponse: (response: IAgentCommandResponse) => Promise<IAgentRendererAck>;
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
    ) => TMenuEventUnsubscribe;
}
