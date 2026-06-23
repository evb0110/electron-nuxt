import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    ASSISTANT_MCP_CONTRACT_VERSION,
    ASSISTANT_MCP_SERVER_NAME,
    ASSISTANT_MCP_TOKEN_ENV,
    createAssistantCodexConfig,
} from '@electron/features/agent/codexAssistantConfig';

function assignPath(target: Record<string, unknown>, path: string[], key: string, value: unknown) {
    let current = target;
    for (const part of path) {
        current[part] ??= {};
        current = current[part] as Record<string, unknown>;
    }
    current[key] = value;
}

function parseTomlValue(value: string): unknown {
    if (value === 'true') {
        return true;
    }
    if (value === 'false') {
        return false;
    }
    if (value.startsWith('"') && value.endsWith('"')) {
        return JSON.parse(value);
    }
    if (value.startsWith('[') && value.endsWith(']')) {
        return value.slice(1, -1)
            .split(',')
            .map(part => part.trim())
            .filter(Boolean)
            .map(part => JSON.parse(part) as string);
    }
    return value;
}

function parseGeneratedToml(config: string) {
    const parsed: Record<string, unknown> = {};
    let tablePath: string[] = [];
    for (const rawLine of config.split('\n')) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        const tableMatch = line.match(/^\[(.+)]$/);
        if (tableMatch?.[1]) {
            tablePath = tableMatch[1].split('.');
            continue;
        }
        const assignment = line.match(/^([^=]+)=\s*(.+)$/);
        if (!assignment?.[1] || !assignment[2]) {
            throw new Error(`Unsupported TOML line: ${line}`);
        }
        assignPath(parsed, tablePath, assignment[1].trim(), parseTomlValue(assignment[2].trim()));
    }
    return parsed;
}

describe('agent assistant Codex config', () => {
    it('versions the embedded MCP server name to refresh cached tool contracts', () => {
        expect(ASSISTANT_MCP_CONTRACT_VERSION).toBeGreaterThanOrEqual(2);
        expect(ASSISTANT_MCP_SERVER_NAME).toBe(`evb_viewer_embedded_v${ASSISTANT_MCP_CONTRACT_VERSION}`);
    });

    it('locks assistant sessions to the embedded EVB MCP server', () => {
        const config = createAssistantCodexConfig('http://127.0.0.1:12345/mcp');
        const parsed = parseGeneratedToml(config) as {
            cli_auth_credentials_store: string;
            model_reasoning_effort: string;
            web_search: string;
            sandbox_mode: string;
            approval_policy: string;
            default_permissions: string;
            features: Record<string, boolean>;
            permissions: Record<string, {
                filesystem: Record<string, string>;
                network: { enabled: boolean } 
            }>;
            mcp_servers: Record<string, {
                url: string;
                bearer_token_env_var: string;
                enabled_tools: string[] 
            }>;
        };

        expect(parsed).toMatchObject({
            cli_auth_credentials_store: 'file',
            model_reasoning_effort: 'high',
            web_search: 'disabled',
            sandbox_mode: 'read-only',
            approval_policy: 'never',
            default_permissions: 'evb-mcp-only',
            features: {
                shell_tool: false,
                unified_exec: false,
                shell_snapshot: false,
                multi_agent: false,
                apps: false,
                memories: false,
                hooks: false,
            },
            permissions: {'evb-mcp-only': {
                filesystem: { '":minimal"': 'read' },
                network: { enabled: false },
            }},
        });
        expect(parsed.mcp_servers[ASSISTANT_MCP_SERVER_NAME]).toEqual({
            url: 'http://127.0.0.1:12345/mcp',
            bearer_token_env_var: ASSISTANT_MCP_TOKEN_ENV,
            enabled_tools: [
                'evb_workspace_snapshot',
                'evb_list_capabilities',
                'evb_describe_capability',
                'evb_read_resource',
                'evb_read_action',
                'evb_run_action',
                'evb_job_status',
            ],
        });
    });
});
