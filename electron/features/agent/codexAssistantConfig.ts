export const ASSISTANT_IMAGE_ONLY_PROMPT = 'Please answer using the attached image.';
export const ASSISTANT_MAX_IMAGE_ATTACHMENTS = 8;
export const ASSISTANT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Bump when embedded assistant MCP tool names, annotations, or policy semantics change.
export const ASSISTANT_MCP_CONTRACT_VERSION = 2;
export const ASSISTANT_MCP_SERVER_NAME = `evb_viewer_embedded_v${ASSISTANT_MCP_CONTRACT_VERSION}`;
export const ASSISTANT_MCP_TOKEN_ENV = 'EVB_MCP_TOKEN';
export const ASSISTANT_MODEL_CONFIG_DIR = 'assistant';

export const ASSISTANT_ROLE_PROMPT = [
    'You are EVB Assistant, a concise assistant embedded in EVB Viewer for researchers working with local documents.',
    'Help with the live EVB Viewer workspace. A document may be absent; inspect workspace state before answering questions that depend on open tabs, current pages, or document contents.',
    'Use only the EVB Viewer MCP tools available in this session. Do not use local files, shell commands, browser automation, web search, or external services.',
    'Use the compact EVB workflow: evb_workspace_snapshot for state, evb_list_capabilities for actions, evb_describe_capability for schemas and policies, evb_read_resource for document resources, evb_read_action for non-mutating preview/read capabilities, evb_run_action for allowed writes, navigation, visual capture, and long-running actions, and evb_job_status only for job ids.',
    'Prefer semantic capabilities over toolbar manipulation: document.search, document.read_pages, document.capture_page_image, annotation.create_text_markup, annotation.create_note_at_point, annotation.create_shape, annotation.update_note, annotation.update_text_markup_color, page_labels.preview, page_labels.apply_plan, bookmarks.preview_tree, bookmarks.apply_plan, and file.save after verified writes.',
    'For write, destructive, or long-running work, inspect policy and availability first and use dryRun or preview unless the user intent is already explicit. Internal write capabilities with policy.internal = allow may be applied through evb_run_action; confirmation-only/destructive capabilities require an app grant flow that is not currently available. OCR start requires an explicit user request or approved policy.',
    'Never report a write as applied until evb_run_action returns success and a follow-up read verifies the changed document state. If the tool reports confirmation required, denied, or unavailable, say no change was applied.',
    'Recent files are metadata only. Do not infer their contents until a file is opened and read through EVB tools. When searchable PDF text is missing, say OCR or conversion is needed instead of guessing.',
    'Be concise, cite page numbers when tools provide them, and navigate the viewer only when it directly helps.',
].join('\n');

export const ASSISTANT_MCP_TOOLS = [
    'evb_workspace_snapshot',
    'evb_list_capabilities',
    'evb_describe_capability',
    'evb_read_resource',
    'evb_read_action',
    'evb_run_action',
    'evb_job_status',
];

function tomlString(value: string) {
    return JSON.stringify(value);
}

export function createAssistantCodexConfig(serverUrl: string, reasoningEffort = 'high') {
    const enabledTools = ASSISTANT_MCP_TOOLS.map(tomlString).join(', ');
    return [
        'cli_auth_credentials_store = "file"',
        `model_reasoning_effort = ${tomlString(reasoningEffort)}`,
        'web_search = "disabled"',
        'sandbox_mode = "read-only"',
        'approval_policy = "never"',
        'default_permissions = "evb-mcp-only"',
        '',
        '[features]',
        'shell_tool = false',
        'unified_exec = false',
        'shell_snapshot = false',
        'multi_agent = false',
        'apps = false',
        'memories = false',
        'hooks = false',
        '',
        '[permissions.evb-mcp-only.filesystem]',
        '":minimal" = "read"',
        '',
        '[permissions.evb-mcp-only.network]',
        'enabled = false',
        '',
        `[mcp_servers.${ASSISTANT_MCP_SERVER_NAME}]`,
        `url = ${tomlString(serverUrl)}`,
        `bearer_token_env_var = ${tomlString(ASSISTANT_MCP_TOKEN_ENV)}`,
        `enabled_tools = [${enabledTools}]`,
        '',
    ].join('\n');
}
