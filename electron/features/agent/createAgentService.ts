import { dialog } from 'electron';
import { te } from '@electron/te';
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
import type {
    IAgentIpcContext,
    IAgentService,
} from '@electron/features/agent/ports';

async function confirmAssistantCodexInstall(context: IAgentIpcContext) {
    const options = {
        type: 'warning',
        title: te('assistant.installCodex'),
        message: te('assistant.installDescription'),
        detail: 'EVB Viewer will download and run the official Codex installer.',
        buttons: [
            te('assistant.installCodex'),
            te('dialogs.agentMcp.cancel'),
        ],
        defaultId: 1,
        cancelId: 1,
    } satisfies Electron.MessageBoxOptions;
    const result = context.parentWindow
        ? await dialog.showMessageBox(context.parentWindow, options)
        : await dialog.showMessageBox(options);
    return result.response === 0;
}

export function createAgentService(): IAgentService {
    return {
        getMcpIntegrationStatus: () => getAgentMcpIntegrationStatus(),
        setMcpIntegrationEnabled: (context, enabled) =>
            setAgentMcpIntegrationEnabled(enabled, context.parentWindow),
        getAssistantState: (_context, request) =>
            getAgentAssistantState(request),
        installAssistantCodex: async (context) => {
            const confirmed = await confirmAssistantCodexInstall(context);
            if (!confirmed) {
                return {
                    ok: false,
                    state: await getAgentAssistantState(),
                    error: 'Codex installation was cancelled.',
                };
            }
            return installAgentAssistantCodex();
        },
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
