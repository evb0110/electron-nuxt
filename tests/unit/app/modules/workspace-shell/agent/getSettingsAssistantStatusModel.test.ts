import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IAgentAssistantStatus } from '@contracts/agent';
import { getSettingsAssistantStatusModel } from '@app/modules/workspace-shell/agent/getSettingsAssistantStatusModel';

function createStatus(overrides: Partial<IAgentAssistantStatus> = {}): IAgentAssistantStatus {
    return {
        supported: true,
        platform: 'darwin',
        provider: 'codex',
        providerLabel: 'Codex',
        providers: [
            {
                id: 'codex',
                label: 'Codex',
                installState: 'installed',
                authState: 'signed-in',
                runtimeState: 'ready',
                models: [
                    {
                        id: 'default',
                        label: 'Codex default',
                    },
                    {
                        id: 'gpt-5.5',
                        label: 'GPT-5.5',
                    },
                ],
                defaultModel: 'default',
                activeModel: 'default',
                modelSwitchMode: 'in-session',
                availableEfforts: [
                    'low',
                    'medium',
                    'high',
                ],
                defaultEffort: 'low',
                activeEffort: 'low',
                availableSpeedModes: [
                    'fast',
                    'standard',
                ],
                defaultSpeedMode: 'fast',
                activeSpeedMode: 'fast',
                path: '/Applications/Codex.app/Contents/Resources/codex',
                version: '0.133.0',
                minimumVersion: '0.133.0',
                versionSupported: true,
                installUrl: 'https://developers.openai.com/codex/app',
                account: {
                    type: 'chatgpt',
                    email: 'reader@example.com',
                },
            },
            {
                id: 'claude',
                label: 'Claude',
                installState: 'installed',
                authState: 'signed-in',
                runtimeState: 'ready',
                models: [{
                    id: 'default',
                    label: 'Claude default',
                }],
                defaultModel: 'default',
                activeModel: 'default',
                modelSwitchMode: 'in-session',
                availableEfforts: [
                    'low',
                    'medium',
                    'high',
                    'xhigh',
                    'max',
                ],
                defaultEffort: 'low',
                activeEffort: 'low',
                availableSpeedModes: [
                    'fast',
                    'standard',
                ],
                defaultSpeedMode: 'fast',
                activeSpeedMode: 'fast',
                path: '/usr/local/bin/claude',
                version: '0.3.183',
                minimumVersion: null,
                versionSupported: true,
                installUrl: 'https://code.claude.com/docs/en/agent-sdk/overview',
                account: null,
            },
        ],
        model: 'default',
        modelLabel: 'Codex default',
        models: [
            {
                id: 'default',
                label: 'Codex default',
            },
            {
                id: 'gpt-5.5',
                label: 'GPT-5.5',
            },
        ],
        modelSwitchMode: 'in-session',
        effort: 'low',
        availableEfforts: [
            'low',
            'medium',
            'high',
        ],
        speedMode: 'fast',
        availableSpeedModes: [
            'fast',
            'standard',
        ],
        installState: 'installed',
        codexInstalled: true,
        codexPath: '/Applications/Codex.app/Contents/Resources/codex',
        codexVersion: '0.133.0',
        minimumCodexVersion: '0.133.0',
        codexVersionSupported: true,
        installUrl: 'https://developers.openai.com/codex/app',
        installScriptUrl: 'https://chatgpt.com/codex/install.sh',
        managedInstallDir: '/Users/test/Library/Application Support/EVB Viewer/codex/bin',
        authState: 'signed-in',
        account: {
            type: 'chatgpt',
            email: 'reader@example.com',
        },
        runtimeState: 'ready',
        mcp: {
            serverName: 'evb_viewer_embedded',
            serverUrl: 'http://127.0.0.1:1234',
            serverRunning: true,
            toolCount: 9,
        },
        turn: {
            id: null,
            phase: 'idle',
            reasoning: '',
            toolActivity: [],
            lastEventAtMs: null,
            usage: null,
        },
        lastCheckedAt: '2026-06-02T00:00:00.000Z',
        ...overrides,
    };
}

function notReadyProviders(): IAgentAssistantStatus['providers'] {
    return createStatus().providers.map(provider => ({
        ...provider,
        installState: 'missing',
        authState: 'signed-out',
        account: null,
    }));
}

describe('getSettingsAssistantStatusModel', () => {
    it('shows setup checking before assistant state has loaded', () => {
        const model = getSettingsAssistantStatusModel(null, false);

        expect(model.label.key).toBe('settings.assistantPanelStatusChecking');
        expect(model.primaryAction).toBeNull();
    });

    it('keeps install and update setup ahead of sign-in', () => {
        expect(getSettingsAssistantStatusModel(createStatus({
            installState: 'missing',
            codexInstalled: false,
            codexVersionSupported: false,
            authState: 'signed-out',
            account: null,
            providers: notReadyProviders(),
        }), true).primaryAction).toBe('install');

        expect(getSettingsAssistantStatusModel(createStatus({
            codexVersionSupported: false,
            minimumCodexVersion: '0.140.0',
            authState: 'signed-out',
            account: null,
            providers: notReadyProviders(),
        }), true)).toMatchObject({
            primaryAction: 'update',
            hint: {
                key: 'settings.assistantPanelNeedsUpdateHint',
                params: { version: '0.140.0' },
            },
        });
    });

    it('uses an explicit ChatGPT sign-in action for signed-out assistant auth', () => {
        const model = getSettingsAssistantStatusModel(createStatus({
            authState: 'signed-out',
            account: null,
            runtimeState: 'stopped',
            providers: notReadyProviders(),
        }), true);

        expect(model.label.key).toBe('settings.assistantPanelStatusSignedOut');
        expect(model.primaryAction).toBe('sign-in');
        expect(model.showCancelLogin).toBe(false);
    });

    it('shows cancel instead of a second sign-in action while login is pending', () => {
        const model = getSettingsAssistantStatusModel(createStatus({
            authState: 'login-pending',
            account: null,
            runtimeState: 'stopped',
            providers: notReadyProviders(),
        }), true);

        expect(model.label.key).toBe('settings.assistantPanelStatusLoginPending');
        expect(model.primaryAction).toBeNull();
        expect(model.showCancelLogin).toBe(true);
    });

    it('summarizes the signed-in account when assistant auth is ready', () => {
        const model = getSettingsAssistantStatusModel(createStatus(), true);

        expect(model.tone).toBe('ready');
        expect(model.label).toEqual({
            key: 'settings.assistantPanelStatusReadyAccount',
            params: { account: 'reader@example.com' },
        });
        expect(model.primaryAction).toBeNull();
    });

    it('reports ready when only Claude is set up and Codex still needs install', () => {
        const claudeReadyProviders = createStatus().providers.map(provider => (
            provider.id === 'claude'
                ? {
                    ...provider,
                    installState: 'installed' as const,
                    authState: 'signed-in' as const,
                }
                : {
                    ...provider,
                    installState: 'missing' as const,
                    authState: 'signed-out' as const,
                    account: null,
                }
        ));
        const model = getSettingsAssistantStatusModel(createStatus({
            installState: 'missing',
            codexInstalled: false,
            authState: 'signed-out',
            account: null,
            providers: claudeReadyProviders,
        }), true);

        expect(model.tone).toBe('ready');
        expect(model.primaryAction).toBeNull();
    });
});
