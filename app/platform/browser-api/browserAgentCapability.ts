import type {
    IAgentAssistantScopedRequest,
    IAgentAssistantState,
    IAgentAssistantStateRequest,
    IAgentMcpIntegrationStatus,
} from '@contracts/agent';
import type { IAgentCapability } from '@contracts/agentCapability';
import {
    ASSISTANT_DEFAULT_EFFORT,
    CLAUDE_ASSISTANT_EFFORTS,
    CLAUDE_ASSISTANT_MODELS,
    CODEX_ASSISTANT_EFFORTS,
    CODEX_ASSISTANT_FALLBACK_MODELS,
} from '@contracts/agentModels';

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
            provider: 'codex',
            providerLabel: 'Codex',
            providers: [
                {
                    id: 'codex',
                    label: 'Codex',
                    installState: 'unsupported',
                    authState: 'unknown',
                    runtimeState: 'stopped',
                    models: [...CODEX_ASSISTANT_FALLBACK_MODELS],
                    defaultModel: 'default',
                    activeModel: 'default',
                    modelSwitchMode: 'in-session',
                    availableEfforts: [...CODEX_ASSISTANT_EFFORTS],
                    defaultEffort: ASSISTANT_DEFAULT_EFFORT,
                    activeEffort: ASSISTANT_DEFAULT_EFFORT,
                    path: null,
                    version: null,
                    minimumVersion: '0.133.0',
                    versionSupported: false,
                    installUrl: 'https://developers.openai.com/codex/app',
                    account: null,
                },
                {
                    id: 'claude',
                    label: 'Claude',
                    installState: 'unsupported',
                    authState: 'unknown',
                    runtimeState: 'stopped',
                    models: [...CLAUDE_ASSISTANT_MODELS],
                    defaultModel: 'default',
                    activeModel: 'default',
                    modelSwitchMode: 'in-session',
                    availableEfforts: [...CLAUDE_ASSISTANT_EFFORTS],
                    defaultEffort: ASSISTANT_DEFAULT_EFFORT,
                    activeEffort: ASSISTANT_DEFAULT_EFFORT,
                    path: null,
                    version: null,
                    minimumVersion: null,
                    versionSupported: false,
                    installUrl: 'https://code.claude.com/docs/en/agent-sdk/overview',
                    account: null,
                },
            ],
            model: 'default',
            modelLabel: 'Codex default',
            models: [...CODEX_ASSISTANT_FALLBACK_MODELS],
            modelSwitchMode: 'in-session',
            effort: ASSISTANT_DEFAULT_EFFORT,
            availableEfforts: [...CODEX_ASSISTANT_EFFORTS],
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

export const browserAgentCapability = {
    onWorkspaceSnapshotRequest: (_callback) => () => {},
    submitWorkspaceSnapshot: (_response) => Promise.resolve({
        accepted: false,
        reason: 'unknown-request' as const,
    }),
    onCommandRequest: (_callback) => () => {},
    submitCommandResponse: (_response) => Promise.resolve({
        accepted: false,
        reason: 'unknown-request' as const,
    }),
    getMcpIntegrationStatus: () => Promise.resolve(createBrowserAgentMcpStatus()),
    setMcpIntegrationEnabled: (_enabled) => Promise.resolve({
        ok: false,
        status: createBrowserAgentMcpStatus(),
    }),
    getAssistantState: (_request?: IAgentAssistantStateRequest) => Promise.resolve(createBrowserAssistantState()),
    installAssistantCodex: () => Promise.resolve({
        ok: false,
        state: createBrowserAssistantState(),
    }),
    startAssistantLogin: (_request) => Promise.resolve({
        ok: false,
        state: createBrowserAssistantState(),
    }),
    cancelAssistantLogin: () => Promise.resolve(createBrowserAssistantState()),
    sendAssistantMessage: (_request) => Promise.resolve({
        ok: false,
        state: createBrowserAssistantState(),
    }),
    interruptAssistant: (_request?: IAgentAssistantScopedRequest) => Promise.resolve(createBrowserAssistantState()),
    resetAssistantChat: (_request?: IAgentAssistantScopedRequest) => Promise.resolve(createBrowserAssistantState()),
    onAssistantEvent: (_callback) => () => {},
} as const satisfies IAgentCapability;
