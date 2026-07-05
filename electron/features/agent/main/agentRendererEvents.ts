import type {
    BrowserWindow,
    WebContents,
} from 'electron';
import {
    AGENT_EVENT_CHANNELS,
    type IAgentEventMap,
} from '@electron/features/agent/contract';

type TAgentRendererEventChannel = Extract<keyof IAgentEventMap, string>;

function sendAgentRendererEvent<TChannel extends TAgentRendererEventChannel>(
    webContents: Pick<WebContents, 'send'>,
    channel: TChannel,
    payload: IAgentEventMap[TChannel],
) {
    webContents.send(channel, payload);
}

export function sendAgentAssistantEvent(
    targetWindow: BrowserWindow,
    payload: IAgentEventMap[typeof AGENT_EVENT_CHANNELS.assistantEvent],
) {
    sendAgentRendererEvent(targetWindow.webContents, AGENT_EVENT_CHANNELS.assistantEvent, payload);
}

export function sendAgentWorkspaceSnapshotRequest(
    targetWindow: BrowserWindow,
    request: IAgentEventMap[typeof AGENT_EVENT_CHANNELS.workspaceSnapshotRequest],
) {
    sendAgentRendererEvent(targetWindow.webContents, AGENT_EVENT_CHANNELS.workspaceSnapshotRequest, request);
}

export function sendAgentCommandRequest(
    targetWindow: BrowserWindow,
    request: IAgentEventMap[typeof AGENT_EVENT_CHANNELS.commandRequest],
) {
    sendAgentRendererEvent(targetWindow.webContents, AGENT_EVENT_CHANNELS.commandRequest, request);
}

export function sendAgentCommandCancelRequest(
    targetWindow: BrowserWindow,
    request: IAgentEventMap[typeof AGENT_EVENT_CHANNELS.commandCancelRequest],
) {
    sendAgentRendererEvent(targetWindow.webContents, AGENT_EVENT_CHANNELS.commandCancelRequest, request);
}
