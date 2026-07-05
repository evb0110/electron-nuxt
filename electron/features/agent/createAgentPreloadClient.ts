import type {IpcRenderer} from 'electron';
import type { IAgentCapability } from '@contracts/agentCapability';
import {
    AGENT_CHANNELS,
    AGENT_EVENT_CHANNELS,
    type IAgentEventMap,
    type IAgentInvokeMap,
} from '@electron/features/agent/contract';
import {
    decodeAgentAssistantEvent,
    decodeAgentCommandCancelRequest,
    decodeAgentCommandRequest,
    decodeAgentWorkspaceSnapshotRequest,
} from '@electron/preload/agentIpcDecoders';
import {
    createTypedIpcEventSubscriber,
    createTypedIpcInvoker,
} from '@electron/preload/ipcClient';

export function createAgentPreloadClient(ipcRenderer: IpcRenderer): IAgentCapability {
    const invoke = createTypedIpcInvoker<IAgentInvokeMap>(ipcRenderer);
    const eventSubscriber = createTypedIpcEventSubscriber<IAgentEventMap>(ipcRenderer);

    return {
        onWorkspaceSnapshotRequest: callback =>
            eventSubscriber.onDecodedPayload(
                AGENT_EVENT_CHANNELS.workspaceSnapshotRequest,
                decodeAgentWorkspaceSnapshotRequest,
                callback,
            ),
        submitWorkspaceSnapshot: response =>
            invoke(AGENT_CHANNELS.submitWorkspaceSnapshot, response),
        onCommandRequest: callback =>
            eventSubscriber.onDecodedPayload(
                AGENT_EVENT_CHANNELS.commandRequest,
                decodeAgentCommandRequest,
                callback,
            ),
        onCommandCancelRequest: callback =>
            eventSubscriber.onDecodedPayload(
                AGENT_EVENT_CHANNELS.commandCancelRequest,
                decodeAgentCommandCancelRequest,
                callback,
            ),
        submitCommandResponse: response =>
            invoke(AGENT_CHANNELS.submitCommandResponse, response),
        getMcpIntegrationStatus: () =>
            invoke(AGENT_CHANNELS.getMcpIntegrationStatus),
        setMcpIntegrationEnabled: enabled =>
            invoke(AGENT_CHANNELS.setMcpIntegrationEnabled, enabled),
        getAssistantState: request =>
            request === undefined
                ? invoke(AGENT_CHANNELS.getAssistantState)
                : invoke(AGENT_CHANNELS.getAssistantState, request),
        installAssistantCodex: () =>
            invoke(AGENT_CHANNELS.installAssistantCodex),
        startAssistantLogin: request =>
            invoke(AGENT_CHANNELS.startAssistantLogin, request),
        cancelAssistantLogin: () =>
            invoke(AGENT_CHANNELS.cancelAssistantLogin),
        sendAssistantMessage: request =>
            invoke(AGENT_CHANNELS.sendAssistantMessage, request),
        interruptAssistant: request =>
            request === undefined
                ? invoke(AGENT_CHANNELS.interruptAssistant)
                : invoke(AGENT_CHANNELS.interruptAssistant, request),
        resetAssistantChat: request =>
            request === undefined
                ? invoke(AGENT_CHANNELS.resetAssistantChat)
                : invoke(AGENT_CHANNELS.resetAssistantChat, request),
        onAssistantEvent: callback =>
            eventSubscriber.onDecodedPayload(
                AGENT_EVENT_CHANNELS.assistantEvent,
                decodeAgentAssistantEvent,
                callback,
            ),
    };
}
