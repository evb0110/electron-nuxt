import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IAgentAssistantStatus } from '@contracts/agent';
import { getAgentAssistantPanelView } from '@app/components/agent/agentAssistantPanelState';

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
