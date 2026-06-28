import type {
    BrowserWindow,
    IpcMainInvokeEvent,
    WebContents,
} from 'electron';
import type { IAgentRendererAck } from '@contracts/agent';
import type { IAgentCapability } from '@contracts/agentCapability';

type TAgentApi = IAgentCapability;

export interface IAgentIpcContext {
    event: IpcMainInvokeEvent;
    sender: WebContents;
    senderId: number;
    parentWindow: BrowserWindow | null;
}

export interface IAgentService {
    getMcpIntegrationStatus: (
        context: IAgentIpcContext,
    ) => ReturnType<TAgentApi['getMcpIntegrationStatus']>;
    setMcpIntegrationEnabled: (
        context: IAgentIpcContext,
        ...args: Parameters<TAgentApi['setMcpIntegrationEnabled']>
    ) => ReturnType<TAgentApi['setMcpIntegrationEnabled']>;
    getAssistantState: (
        context: IAgentIpcContext,
        ...args: Parameters<TAgentApi['getAssistantState']>
    ) => ReturnType<TAgentApi['getAssistantState']>;
    installAssistantCodex: (
        context: IAgentIpcContext,
    ) => ReturnType<TAgentApi['installAssistantCodex']>;
    startAssistantLogin: (
        context: IAgentIpcContext,
        ...args: Parameters<TAgentApi['startAssistantLogin']>
    ) => ReturnType<TAgentApi['startAssistantLogin']>;
    cancelAssistantLogin: (
        context: IAgentIpcContext,
    ) => ReturnType<TAgentApi['cancelAssistantLogin']>;
    sendAssistantMessage: (
        context: IAgentIpcContext,
        ...args: Parameters<TAgentApi['sendAssistantMessage']>
    ) => ReturnType<TAgentApi['sendAssistantMessage']>;
    interruptAssistant: (
        context: IAgentIpcContext,
        ...args: Parameters<TAgentApi['interruptAssistant']>
    ) => ReturnType<TAgentApi['interruptAssistant']>;
    resetAssistantChat: (
        context: IAgentIpcContext,
        ...args: Parameters<TAgentApi['resetAssistantChat']>
    ) => ReturnType<TAgentApi['resetAssistantChat']>;
    submitWorkspaceSnapshot: (
        context: IAgentIpcContext,
        response: unknown,
    ) => Promise<IAgentRendererAck>;
    submitCommandResponse: (
        context: IAgentIpcContext,
        response: unknown,
    ) => Promise<IAgentRendererAck>;
    shutdownAssistant: () => Promise<void>;
}
