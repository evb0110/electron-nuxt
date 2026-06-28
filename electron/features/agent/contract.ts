import type {
    IAgentAssistantEvent,
    IAgentCommandRequest,
    IAgentWorkspaceSnapshotRequest,
} from '@contracts/agent';
import type { IAgentCapability } from '@contracts/agentCapability';

export const AGENT_CHANNELS = {
    getMcpIntegrationStatus: 'agent:getMcpIntegrationStatus',
    setMcpIntegrationEnabled: 'agent:setMcpIntegrationEnabled',
    getAssistantState: 'agent:getAssistantState',
    installAssistantCodex: 'agent:installAssistantCodex',
    startAssistantLogin: 'agent:startAssistantLogin',
    cancelAssistantLogin: 'agent:cancelAssistantLogin',
    sendAssistantMessage: 'agent:sendAssistantMessage',
    interruptAssistant: 'agent:interruptAssistant',
    resetAssistantChat: 'agent:resetAssistantChat',
    submitWorkspaceSnapshot: 'agent:submitWorkspaceSnapshot',
    submitCommandResponse: 'agent:submitCommandResponse',
} as const;

export const AGENT_EVENT_CHANNELS = {
    assistantEvent: 'agent:assistantEvent',
    workspaceSnapshotRequest: 'agent:workspaceSnapshotRequest',
    commandRequest: 'agent:commandRequest',
} as const;

export interface IAgentInvokeMap {
    [AGENT_CHANNELS.getMcpIntegrationStatus]: {
        args: [];
        result: Awaited<ReturnType<IAgentCapability['getMcpIntegrationStatus']>>;
    };
    [AGENT_CHANNELS.setMcpIntegrationEnabled]: {
        args: Parameters<IAgentCapability['setMcpIntegrationEnabled']>;
        result: Awaited<ReturnType<IAgentCapability['setMcpIntegrationEnabled']>>;
    };
    [AGENT_CHANNELS.getAssistantState]: {
        args: Parameters<IAgentCapability['getAssistantState']>;
        result: Awaited<ReturnType<IAgentCapability['getAssistantState']>>;
    };
    [AGENT_CHANNELS.installAssistantCodex]: {
        args: [];
        result: Awaited<ReturnType<IAgentCapability['installAssistantCodex']>>;
    };
    [AGENT_CHANNELS.startAssistantLogin]: {
        args: Parameters<IAgentCapability['startAssistantLogin']>;
        result: Awaited<ReturnType<IAgentCapability['startAssistantLogin']>>;
    };
    [AGENT_CHANNELS.cancelAssistantLogin]: {
        args: [];
        result: Awaited<ReturnType<IAgentCapability['cancelAssistantLogin']>>;
    };
    [AGENT_CHANNELS.sendAssistantMessage]: {
        args: Parameters<IAgentCapability['sendAssistantMessage']>;
        result: Awaited<ReturnType<IAgentCapability['sendAssistantMessage']>>;
    };
    [AGENT_CHANNELS.interruptAssistant]: {
        args: Parameters<IAgentCapability['interruptAssistant']>;
        result: Awaited<ReturnType<IAgentCapability['interruptAssistant']>>;
    };
    [AGENT_CHANNELS.resetAssistantChat]: {
        args: Parameters<IAgentCapability['resetAssistantChat']>;
        result: Awaited<ReturnType<IAgentCapability['resetAssistantChat']>>;
    };
    [AGENT_CHANNELS.submitWorkspaceSnapshot]: {
        args: Parameters<IAgentCapability['submitWorkspaceSnapshot']>;
        result: Awaited<ReturnType<IAgentCapability['submitWorkspaceSnapshot']>>;
    };
    [AGENT_CHANNELS.submitCommandResponse]: {
        args: Parameters<IAgentCapability['submitCommandResponse']>;
        result: Awaited<ReturnType<IAgentCapability['submitCommandResponse']>>;
    };
}

export interface IAgentEventMap {
    [AGENT_EVENT_CHANNELS.assistantEvent]: IAgentAssistantEvent;
    [AGENT_EVENT_CHANNELS.workspaceSnapshotRequest]: IAgentWorkspaceSnapshotRequest;
    [AGENT_EVENT_CHANNELS.commandRequest]: IAgentCommandRequest;
}
