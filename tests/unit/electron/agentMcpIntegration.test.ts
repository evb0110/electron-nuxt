import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const state = vi.hoisted(() => ({
    settings: {agentMcpEnabled: false},
    serverRunning: false,
}));

const mocks = vi.hoisted(() => ({
    loadSettings: vi.fn(async () => ({...state.settings})),
    updateSettings: vi.fn(async (mutate: (settings: Record<string, unknown>) => unknown) => {
        const next = {...state.settings};
        mutate(next);
        state.settings = {agentMcpEnabled: Boolean(next.agentMcpEnabled)};
        return {...state.settings};
    }),
    resolveCodexCliPath: vi.fn(async () => '/usr/bin/codex'),
    runCodexCli: vi.fn(),
    startLocalMcpServer: vi.fn(async () => {
        state.serverRunning = true;
    }),
    shutdownLocalMcpServer: vi.fn(async () => {
        state.serverRunning = false;
    }),
    showMessageBox: vi.fn(async () => ({response: 0})),
    openExternal: vi.fn(async () => undefined),
}));

const descriptor = {
    name: 'evb_viewer_dev',
    title: 'EVB Viewer Dev',
    host: '127.0.0.1',
    port: 38672,
    url: 'http://127.0.0.1:38672',
};

const launchConfig = {
    command: '/usr/bin/electron',
    args: ['/opt/evb/scripts/evb-mcp-proxy.mjs'],
    env: {
        ELECTRON_RUN_AS_NODE: '1',
        EVB_MCP_URL: descriptor.url,
        EVB_MCP_TOKEN: 'persisted-token',
    },
};

vi.mock('electron', () => ({
    dialog: {showMessageBox: mocks.showMessageBox},
    shell: {openExternal: mocks.openExternal},
}));

vi.mock('@electron/settings', () => ({
    loadSettings: mocks.loadSettings,
    updateSettings: mocks.updateSettings,
}));

vi.mock('@electron/features/agent/codexCli', () => ({
    CODEX_APP_INSTALL_URL: 'https://developers.openai.com/codex/app',
    resolveCodexCliPath: mocks.resolveCodexCliPath,
    runCodexCli: mocks.runCodexCli,
}));

vi.mock('@electron/features/agent/mcpServer', () => ({
    getLocalMcpServerDescriptor: () => descriptor,
    getLocalMcpSetupSnippets: vi.fn(async () => ({
        codex: 'codex snippet',
        claude: 'claude snippet',
        cursor: '{ "cursor": true }',
    })),
    getLocalMcpCodexRegistrationTransport: vi.fn(async () => ({
        descriptor,
        launchConfig,
        token: launchConfig.env.EVB_MCP_TOKEN,
    })),
    isLocalMcpServerRunning: () => state.serverRunning,
    startLocalMcpServer: mocks.startLocalMcpServer,
    shutdownLocalMcpServer: mocks.shutdownLocalMcpServer,
}));

vi.mock('@electron/te', () => ({te: (_key: string, values?: Record<string, string>) => values?.server ?? 'translated'}));

describe('codexMcpIntegration', () => {
    beforeEach(() => {
        state.settings = {agentMcpEnabled: false};
        state.serverRunning = false;
        mocks.loadSettings.mockClear();
        mocks.updateSettings.mockClear();
        mocks.resolveCodexCliPath.mockClear();
        mocks.runCodexCli.mockReset();
        mocks.startLocalMcpServer.mockClear();
        mocks.shutdownLocalMcpServer.mockClear();
        mocks.showMessageBox.mockClear();
        mocks.openExternal.mockClear();
    });

    it('registers Codex against the durable stdio proxy transport', async () => {
        mocks.runCodexCli.mockImplementation(async (_codexPath: string, args: string[]) => {
            if (args[0] === 'mcp' && args[1] === 'remove') {
                return {
                    ok: true,
                    stdout: '',
                    stderr: '',
                };
            }
            if (args[0] === 'mcp' && args[1] === 'add') {
                return {
                    ok: true,
                    stdout: '',
                    stderr: '',
                };
            }
            throw new Error(`Unexpected Codex args: ${args.join(' ')}`);
        });

        const { setAgentMcpIntegrationEnabled } = await import('@electron/features/agent/codexMcpIntegration');
        const result = await setAgentMcpIntegrationEnabled(true);

        expect(result.ok).toBe(true);
        expect(mocks.startLocalMcpServer).toHaveBeenCalledOnce();
        expect(mocks.runCodexCli).toHaveBeenNthCalledWith(1, '/usr/bin/codex', [
            'mcp',
            'remove',
            descriptor.name,
        ]);
        expect(mocks.runCodexCli).toHaveBeenNthCalledWith(2, '/usr/bin/codex', [
            'mcp',
            'add',
            descriptor.name,
            '--env',
            'ELECTRON_RUN_AS_NODE=1',
            '--env',
            `EVB_MCP_URL=${descriptor.url}`,
            '--env',
            'EVB_MCP_TOKEN=persisted-token',
            '--',
            launchConfig.command,
            ...launchConfig.args,
        ]);
        expect(state.settings.agentMcpEnabled).toBe(true);
    });

    it('treats legacy URL-only Codex registrations as mismatched and preserves authenticated setup snippets', async () => {
        state.settings = {agentMcpEnabled: true};
        state.serverRunning = true;
        mocks.runCodexCli.mockResolvedValue({
            ok: true,
            stdout: JSON.stringify({
                enabled: true,
                transport: {
                    type: 'streamable_http',
                    url: descriptor.url,
                },
            }),
            stderr: '',
        });

        const { getAgentMcpIntegrationStatus } = await import('@electron/features/agent/codexMcpIntegration');
        const status = await getAgentMcpIntegrationStatus();

        expect(status.enabled).toBe(true);
        expect(status.serverRunning).toBe(true);
        expect(status.codexConfigured).toBe(false);
        expect(status.codexRegistrationState).toBe('mismatched');
        expect(status.setupSnippets).toEqual({
            codex: 'codex snippet',
            claude: 'claude snippet',
            cursor: '{ "cursor": true }',
        });
    });
});
