import {
    describe,
    expect,
    it,
} from 'vitest';
import { AGENT_CAPABILITY_TEMPLATES } from '@electron/features/agent/mcp/mcpDefinitions';
import {
    MCP_TOOLS,
    validateJsonObjectAgainstSchema,
} from '@electron/features/agent/mcp/mcpToolDefinitions';
import { ASSISTANT_MCP_TOOL_HANDLER_NAMES } from '@electron/features/agent/mcp/mcpServerCore';
import { resolveAgentCommandRequestTimeoutMs } from '@electron/features/agent/workspaceBridge';

describe('assistant tool contract invariants', () => {
    it('maps every advertised tool to exactly one handler and keeps capability ids unique', () => {
        expect(new Set(MCP_TOOLS.map(tool => tool.name))).toEqual(new Set(ASSISTANT_MCP_TOOL_HANDLER_NAMES));
        const capabilityIds = AGENT_CAPABILITY_TEMPLATES.map(capability => capability.id);
        expect(new Set(capabilityIds).size).toBe(capabilityIds.length);
    });

    it('derives every advertised action input branch directly from the canonical capability catalog', () => {
        const actionTool = MCP_TOOLS.find(tool => tool.name === 'evb_run_action');
        const branches = actionTool?.inputSchema.oneOf as Array<{properties: {
            id: {const: string};
            input: Record<string, unknown>;
        }}>;
        expect(branches).toHaveLength(AGENT_CAPABILITY_TEMPLATES.length);
        for (const template of AGENT_CAPABILITY_TEMPLATES) {
            const branch = branches.find(candidate => candidate.properties.id.const === template.id);
            expect(branch?.properties.input).toBe(template.inputSchema);
        }
    });

    it('uses the advertised schema itself as the recursive runtime validator', () => {
        const template = AGENT_CAPABILITY_TEMPLATES.find(candidate => candidate.id === 'document.search');
        expect(template).toBeDefined();
        expect(() => validateJsonObjectAgainstSchema('document.search', {
            query: 'needle',
            unexpected: true,
        }, template?.inputSchema ?? {})).toThrow(/advertised schema/u);
        expect(() => validateJsonObjectAgainstSchema('document.search', {query: 'needle'}, template?.inputSchema ?? {})).not.toThrow();
    });

    it.each([
        'ocr.start',
        'export.docx',
        'export.images',
        'export.multi_page_tiff',
        'page_ops.convert_to_pdf',
    ])('uses the long-running timeout for %s', (id) => {
        expect(resolveAgentCommandRequestTimeoutMs({
            name: 'run_action',
            arguments: {id},
        })).toBe(180_000);
    });
});
