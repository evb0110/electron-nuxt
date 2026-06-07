import type {
    IAgentAssistantState,
    IAgentMcpIntegrationStatus,
} from '@contracts/agent';
import type { IAgentCapability } from '@contracts/agentCapability';

export function createBrowserAgentMcpStatus(): IAgentMcpIntegrationStatus {
    return {
        enabled: false,
        serverName: 'evb_viewer',
        serverUrl: '',
        serverRunning: false,
        codexInstalled: false,
        codexPath: null,
        codexConfigured: false,
        codexRegistrationState: 'unknown',
        installUrl: 'https://developers.openai.com/codex/app',
        lastCheckedAt: new Date().toISOString(),
    };
}

export function createBrowserAssistantState(): IAgentAssistantState {
    return {
        scope: null,
        status: {
            supported: false,
            platform: 'browser',
            installState: 'unsupported',
            codexInstalled: false,
            codexPath: null,
            codexVersion: null,
            minimumCodexVersion: '0.133.0',
            codexVersionSupported: false,
            installUrl: 'https://developers.openai.com/codex/app',
            installScriptUrl: '',
            managedInstallDir: '',
            authState: 'unknown',
            account: null,
            runtimeState: 'stopped',
            mcp: {
                serverName: 'evb_viewer_embedded',
                serverUrl: '',
                serverRunning: false,
                toolCount: 0,
            },
            turn: {
                id: null,
                phase: 'idle',
            },
            threadId: null,
            activeTurnId: null,
            lastCheckedAt: new Date().toISOString(),
        },
        messages: [],
    };
}

export const browserAgentCapability: IAgentCapability = {
    onWorkspaceSnapshotRequest: () => () => {},
    submitWorkspaceSnapshot: () => Promise.resolve(false),
    onCommandRequest: () => () => {},
    submitCommandResponse: () => Promise.resolve(false),
    getMcpIntegrationStatus: () => Promise.resolve(createBrowserAgentMcpStatus()),
    setMcpIntegrationEnabled: () => Promise.resolve({
        ok: false,
        status: createBrowserAgentMcpStatus(),
    }),
    getAssistantState: () => Promise.resolve(createBrowserAssistantState()),
    installAssistantCodex: () => Promise.resolve({
        ok: false,
        state: createBrowserAssistantState(),
    }),
    startAssistantLogin: () => Promise.resolve({
        ok: false,
        state: createBrowserAssistantState(),
    }),
    cancelAssistantLogin: () => Promise.resolve(createBrowserAssistantState()),
    sendAssistantMessage: () => Promise.resolve({
        ok: false,
        state: createBrowserAssistantState(),
    }),
    interruptAssistant: () => Promise.resolve(createBrowserAssistantState()),
    resetAssistantChat: () => Promise.resolve(createBrowserAssistantState()),
    onAssistantEvent: () => () => {},
};
