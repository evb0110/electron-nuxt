import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    ASSISTANT_MCP_SERVER_NAME,
    ASSISTANT_MCP_TOKEN_ENV,
    ASSISTANT_MCP_TOOLS,
    createAssistantCodexConfig,
} from '@electron/features/agent/codexAssistantConfig';

describe('agent assistant Codex config', () => {
    it('locks assistant sessions to the embedded EVB MCP server', () => {
        const config = createAssistantCodexConfig('http://127.0.0.1:12345/mcp');

        expect(config).toContain('web_search = "disabled"');
        expect(config).toContain('sandbox_mode = "read-only"');
        expect(config).toContain('approval_policy = "never"');
        expect(config).toContain(`[mcp_servers.${ASSISTANT_MCP_SERVER_NAME}]`);
        expect(config).toContain(`bearer_token_env_var = "${ASSISTANT_MCP_TOKEN_ENV}"`);
        expect(config).toContain(`enabled_tools = [${ASSISTANT_MCP_TOOLS.map(tool => `"${tool}"`).join(', ')}]`);
    });
});
