import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IAgentAssistantStatus } from '@contracts/agent';
import { getSettingsAssistantStatusModel } from '@app/modules/workspace-shell/agent/getSettingsAssistantStatusModel';
import { createAgentAssistantStatus as createStatus } from '@tests/helpers/createAgentAssistantStatus';

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
