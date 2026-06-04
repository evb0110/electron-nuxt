import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IAgentAssistantStatus } from '@contracts/agent';
import { getSettingsAssistantStatusModel } from '@app/components/settings/settingsAssistantStatus';

function createStatus(overrides: Partial<IAgentAssistantStatus> = {}): IAgentAssistantStatus {
    return {
        supported: true,
        platform: 'darwin',
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
        }), true).primaryAction).toBe('install');

        expect(getSettingsAssistantStatusModel(createStatus({
            codexVersionSupported: false,
            minimumCodexVersion: '0.140.0',
            authState: 'signed-out',
            account: null,
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
});
