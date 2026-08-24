import {
    describe,
    expect,
    it,
} from 'vitest';
import { getAgentAssistantPanelView } from '@app/modules/agent-panel/public/agentAssistantPanelView';
import { createAgentAssistantStatus as createStatus } from '@tests/helpers/createAgentAssistantStatus';

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

    it('keeps runtime failures separate from authentication setup', () => {
        const status = createStatus({
            authState: 'unknown',
            account: null,
            runtimeState: 'error',
            error: 'Codex app-server exited: invalid transport.',
        });

        expect(getAgentAssistantPanelView(status, true)).toBe('error');
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
