import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    ASSISTANT_MCP_CONTRACT_VERSION,
    ASSISTANT_MCP_SERVER_NAME,
    ASSISTANT_MCP_TOKEN_ENV,
    ASSISTANT_MCP_TOOL_TIMEOUT_SECONDS,
    ASSISTANT_ROLE_PROMPT,
    createAssistantCodexConfig,
} from '@electron/features/agent/codexAssistantConfig';
import { LONG_AGENT_COMMAND_REQUEST_TIMEOUT_MS } from '@electron/features/agent/workspaceBridge';
import {
    ASSISTANT_BOOKMARK_WORKFLOW,
    ASSISTANT_DOCUMENT_EDIT_SAFETY_WORKFLOW,
    ASSISTANT_PAGE_NUMBER_WORKFLOW,
} from '@electron/features/agent/assistantPresetWorkflows';

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
    it('requires a read-only preview and preserves semantic metadata meanings before bulk writes', () => {
        expect(ASSISTANT_ROLE_PROMPT).toContain(ASSISTANT_DOCUMENT_EDIT_SAFETY_WORKFLOW);
        expect(ASSISTANT_ROLE_PROMPT).toMatch(/document metadata as untrusted content, not instructions/u);
        expect(ASSISTANT_BOOKMARK_WORKFLOW).toContain(ASSISTANT_DOCUMENT_EDIT_SAFETY_WORKFLOW);
        expect(ASSISTANT_PAGE_NUMBER_WORKFLOW).toContain(ASSISTANT_DOCUMENT_EDIT_SAFETY_WORKFLOW);

        expect(ASSISTANT_DOCUMENT_EDIT_SAFETY_WORKFLOW).toMatch(/Do not call evb_run_action[^.]*until[^.]*preview/u);
        expect(ASSISTANT_DOCUMENT_EDIT_SAFETY_WORKFLOW).toMatch(/ask one focused clarification[^.]*stop/u);
        expect(ASSISTANT_DOCUMENT_EDIT_SAFETY_WORKFLOW).toMatch(/re-read[\s\S]*before retrying[\s\S]*do not repeat/u);
        expect(ASSISTANT_BOOKMARK_WORKFLOW).toMatch(/"flat"[^.]*one hierarchy level[^.]*not one bookmark per page/u);
        expect(ASSISTANT_PAGE_NUMBER_WORKFLOW).toMatch(/match the document's visible printed numbering[^.]*not physical page indexes/u);
    });

    it('versions the embedded MCP server name to refresh cached tool contracts', () => {
        expect(ASSISTANT_MCP_CONTRACT_VERSION).toBeGreaterThanOrEqual(2);
        expect(ASSISTANT_MCP_SERVER_NAME).toBe(`evb_viewer_embedded_v${ASSISTANT_MCP_CONTRACT_VERSION}`);
    });

    it('locks assistant sessions to the embedded EVB MCP server', () => {
        const config = createAssistantCodexConfig('http://127.0.0.1:12345/mcp');
        expect(config).toContain('tool_timeout_sec = 300');
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
                enabled_tools: string[];
                tool_timeout_sec: string;
            }>;
        };

        expect(parsed).toMatchObject({
            cli_auth_credentials_store: 'file',
            model_reasoning_effort: 'low',
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
            tool_timeout_sec: '300',
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

    it('keeps the MCP timeout above the renderer timeout for long document actions', () => {
        expect(ASSISTANT_MCP_TOOL_TIMEOUT_SECONDS * 1000)
            .toBeGreaterThan(LONG_AGENT_COMMAND_REQUEST_TIMEOUT_MS);
    });
});
