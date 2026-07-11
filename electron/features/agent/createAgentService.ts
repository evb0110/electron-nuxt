import {
    cancelAgentAssistantLogin,
    getAgentAssistantState,
    installAgentAssistantCodex,
    interruptAgentAssistant,
    resetAgentAssistantChat,
    sendAgentAssistantMessage,
    shutdownAgentAssistant,
    startAgentAssistantLogin,
} from '@electron/features/agent/codexAssistant';
import {
    getAgentMcpIntegrationStatus,
    setAgentMcpIntegrationEnabled,
} from '@electron/features/agent/codexMcpIntegration';
import {
    submitAgentCommandResponse,
    submitAgentWorkspaceSnapshotResponse,
} from '@electron/features/agent/workspaceBridge';
import type { IAgentService } from '@electron/features/agent/ports';

export function createAgentService(): IAgentService {
    return {
        getMcpIntegrationStatus: () => getAgentMcpIntegrationStatus(),
        setMcpIntegrationEnabled: (context, enabled) =>
            setAgentMcpIntegrationEnabled(enabled, context.parentWindow),
        getAssistantState: (_context, request) =>
            getAgentAssistantState(request),
        installAssistantCodex: () => installAgentAssistantCodex(),
        startAssistantLogin: (context, request) =>
            startAgentAssistantLogin(request, context.parentWindow),
        cancelAssistantLogin: () => cancelAgentAssistantLogin(),
        sendAssistantMessage: (context, request) =>
            sendAgentAssistantMessage(request, { windowId: context.parentWindow?.id ?? null }),
        interruptAssistant: (_context, request) =>
            interruptAgentAssistant(request),
        resetAssistantChat: (_context, request) =>
            resetAgentAssistantChat(request),
        submitWorkspaceSnapshot: (context, response) =>
            Promise.resolve(submitAgentWorkspaceSnapshotResponse(context.event, response)),
        submitCommandResponse: (context, response) =>
            Promise.resolve(submitAgentCommandResponse(context.event, response)),
        shutdownAssistant: () => shutdownAgentAssistant(),
    };
}
