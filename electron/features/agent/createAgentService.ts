import {
    BrowserWindow,
    type IpcMainInvokeEvent,
} from 'electron';
import type { AGENT_PLATFORM_FEATURE } from '@contracts/agentPlatformFeature';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import {
    cancelAgentAssistantLogin,
    getAgentAssistantState,
    installAgentAssistantCodex,
    interruptAgentAssistant,
    resetAgentAssistantChat,
    sendAgentAssistantMessage,
    shutdownAgentAssistantIfLoaded,
    startAgentAssistantLogin,
} from '@electron/features/agent/lazyAgentAssistant';
import {
    getAgentMcpIntegrationStatus,
    setAgentMcpIntegrationEnabled,
} from '@electron/features/agent/codexMcpIntegration';
import {
    submitAgentCommandResponse,
    submitAgentWorkspaceSnapshotResponse,
} from '@electron/features/agent/workspaceBridge';

export function createAgentService() {
    return {
        getMcpIntegrationStatus: () => getAgentMcpIntegrationStatus(),
        setMcpIntegrationEnabled: (context, enabled) =>
            setAgentMcpIntegrationEnabled(
                enabled,
                BrowserWindow.fromWebContents(context.sender),
            ),
        getAssistantState: (_context, request) =>
            getAgentAssistantState(request),
        installAssistantCodex: () => installAgentAssistantCodex(),
        startAssistantLogin: (context, request) =>
            startAgentAssistantLogin(
                request,
                BrowserWindow.fromWebContents(context.sender),
            ),
        cancelAssistantLogin: () => cancelAgentAssistantLogin(),
        sendAssistantMessage: (context, request) =>
            sendAgentAssistantMessage(request, {windowId: BrowserWindow.fromWebContents(context.sender)?.id ?? null}),
        interruptAssistant: (_context, request) =>
            interruptAgentAssistant(request),
        resetAssistantChat: (_context, request) =>
            resetAgentAssistantChat(request),
        submitWorkspaceSnapshot: (context, response) =>
            Promise.resolve(submitAgentWorkspaceSnapshotResponse(context, response)),
        submitCommandResponse: (context, response) =>
            Promise.resolve(submitAgentCommandResponse(context, response)),
        shutdownAssistant: () => shutdownAgentAssistantIfLoaded(),
    } satisfies TFeatureMainBindings<typeof AGENT_PLATFORM_FEATURE, IpcMainInvokeEvent>
        & {shutdownAssistant: () => Promise<void>};
}

export type TAgentService = ReturnType<typeof createAgentService>;
