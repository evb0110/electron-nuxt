import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    browserAgentCapability,
    createBrowserAgentMcpStatus,
    createBrowserAssistantState,
} from '@app/platform/browser-api/browserAgentCapability';

describe('browserAgentCapability', () => {
    it('reports assistant support as unavailable in browser runtime', async () => {
        const state = await browserAgentCapability.getAssistantState();

        expect(state.status.supported).toBe(false);
        expect(state.status.platform).toBe('browser');
        expect(state.status.installState).toBe('unsupported');
        expect(state.status.runtimeState).toBe('stopped');
        expect(state.messages).toEqual([]);
    });

    it('does not accept browser assistant commands', async () => {
        await expect(browserAgentCapability.submitWorkspaceSnapshot({
            requestId: 'snapshot-1',
            ok: false,
        })).resolves.toBe(false);
        await expect(browserAgentCapability.submitCommandResponse({
            requestId: 'command-1',
            ok: false,
        })).resolves.toBe(false);
        const sendResult = await browserAgentCapability.sendAssistantMessage({ text: 'hello' });
        expect(sendResult.ok).toBe(false);
        expect(sendResult.state.status).toMatchObject({
            supported: false,
            platform: 'browser',
        });
    });

    it('keeps browser fallback state and MCP status in sync with the contract', () => {
        expect(createBrowserAgentMcpStatus()).toMatchObject({
            enabled: false,
            serverName: 'evb_viewer',
            serverRunning: false,
            codexInstalled: false,
            codexConfigured: false,
        });
        expect(createBrowserAssistantState().status.mcp).toMatchObject({
            serverName: 'evb_viewer_embedded',
            serverRunning: false,
            toolCount: 0,
        });
    });
});
