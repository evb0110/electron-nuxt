import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    loadSettings: vi.fn(async () => ({assistantPanelEnabled: false})),
    getCodexCliInfo: vi.fn(),
    installManagedCodex: vi.fn(),
    spawn: vi.fn(),
    assistantDisabledMessage: 'Enable EVB Assistant in Settings to use assistant chat.',
    startEmbeddedMcpServer: vi.fn(),
    shutdownEmbeddedMcpServer: vi.fn(async () => undefined),
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('electron', () => ({
    app: {
        focus: vi.fn(),
        getPath: vi.fn(() => '/tmp/evb-viewer-test'),
    },
    BrowserWindow: {
        getAllWindows: vi.fn(() => []),
        getFocusedWindow: vi.fn(() => null),
    },
    shell: {openExternal: vi.fn()},
}));

vi.mock('child_process', () => ({spawn: mocks.spawn}));

vi.mock('@electron/settings', () => ({loadSettings: mocks.loadSettings}));

vi.mock('@electron/i18n', () => ({te: (key: string) => key === 'dialogs.agentAssistant.disabledMessage' ? mocks.assistantDisabledMessage : key}));

vi.mock('@electron/config', () => ({config: {automation: {noFocus: true}}}));

vi.mock('@electron/features/agent/codexCli', () => ({
    CODEX_APP_INSTALL_URL: 'https://developers.openai.com/codex/app',
    CODEX_STANDALONE_INSTALL_URL: 'https://example.test/install-codex',
    getCodexCliInfo: mocks.getCodexCliInfo,
    installManagedCodex: mocks.installManagedCodex,
}));

vi.mock('@electron/features/agent/mcpServer', () => ({
    getEmbeddedMcpServerDescriptor: vi.fn(() => null),
    isEmbeddedMcpServerRunning: vi.fn(() => false),
    shutdownEmbeddedMcpServer: mocks.shutdownEmbeddedMcpServer,
    startEmbeddedMcpServer: mocks.startEmbeddedMcpServer,
}));

vi.mock('@electron/utils/logger', () => ({createLogger: () => mocks.logger}));

describe('agent assistant opt-in gating', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.loadSettings.mockResolvedValue({assistantPanelEnabled: false});
    });

    it('does not discover Codex or start MCP when disabled state is requested', async () => {
        const { getAgentAssistantState } = await import('@electron/features/agent/codexAssistant');

        const state = await getAgentAssistantState();

        expect(state.status.runtimeState).toBe('stopped');
        expect(state.status.mcp.serverRunning).toBe(false);
        expect(mocks.getCodexCliInfo).not.toHaveBeenCalled();
        expect(mocks.startEmbeddedMcpServer).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('rejects assistant chat actions while disabled', async () => {
        const { sendAgentAssistantMessage } = await import('@electron/features/agent/codexAssistant');

        const result = await sendAgentAssistantMessage({text: 'Summarize this document'});

        expect(result.ok).toBe(false);
        expect(result.error).toBe(mocks.assistantDisabledMessage);
        expect(mocks.getCodexCliInfo).not.toHaveBeenCalled();
        expect(mocks.startEmbeddedMcpServer).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
});
