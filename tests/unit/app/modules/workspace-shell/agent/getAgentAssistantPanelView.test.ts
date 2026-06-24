import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IAgentAssistantStatus } from '@contracts/agent';
import { getAgentAssistantPanelView } from '@app/modules/workspace-shell/agent/getAgentAssistantPanelView';

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
        },
        threadId: null,
        activeTurnId: null,
        lastCheckedAt: '2026-06-02T00:00:00.000Z',
        ...overrides,
    };
}

describe('getAgentAssistantPanelView', () => {
    it('keeps the initial unresolved state in the checking view', () => {
        expect(getAgentAssistantPanelView(createStatus(), false)).toBe('checking');
    });

    it('does not show sign-in while cold-start auth probing is still running', () => {
        const status = createStatus({
            authState: 'unknown',
            account: null,
            runtimeState: 'starting',
        });

        expect(getAgentAssistantPanelView(status, true)).toBe('checking');
    });

    it('keeps indeterminate auth separate from confirmed signed-out auth', () => {
        const status = createStatus({
            authState: 'unknown',
            account: null,
            runtimeState: 'stopped',
        });

        expect(getAgentAssistantPanelView(status, true)).toBe('checking');
    });

    it('does not keep a failed auth probe in the checking view', () => {
        const status = createStatus({
            authState: 'unknown',
            account: null,
            runtimeState: 'error',
            error: 'Could not verify Codex authentication.',
        });

        expect(getAgentAssistantPanelView(status, true)).toBe('sign-in');
    });

    it('shows sign-in only for confirmed signed-out or pending login states', () => {
        expect(getAgentAssistantPanelView(createStatus({
            authState: 'signed-out',
            account: null,
            runtimeState: 'stopped',
        }), true)).toBe('sign-in');
        expect(getAgentAssistantPanelView(createStatus({
            authState: 'login-pending',
            account: null,
            runtimeState: 'stopped',
        }), true)).toBe('sign-in');
    });

    it('shows the ready assistant only for signed-in auth', () => {
        expect(getAgentAssistantPanelView(createStatus(), true)).toBe('ready');
    });

    it('lets an unauthenticated Claude provider reach the sign-in view', () => {
        expect(getAgentAssistantPanelView(createStatus({
            provider: 'claude',
            installState: 'installed',
            authState: 'signed-out',
            runtimeState: 'stopped',
            codexVersionSupported: false,
        }), true)).toBe('sign-in');
    });

    it('keeps setup states ahead of auth states', () => {
        expect(getAgentAssistantPanelView(createStatus({
            supported: false,
            installState: 'unsupported',
            authState: 'signed-in',
        }), true)).toBe('unsupported');
        expect(getAgentAssistantPanelView(createStatus({
            installState: 'missing',
            codexInstalled: false,
            codexVersionSupported: false,
            authState: 'unknown',
        }), true)).toBe('install');
        expect(getAgentAssistantPanelView(createStatus({
            codexVersionSupported: false,
            authState: 'unknown',
        }), true)).toBe('update');
    });
});
