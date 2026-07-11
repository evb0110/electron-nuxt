import type { IProcessMcpRequestOptions } from '@electron/features/agent/mcp/mcpServerCore';
import { processMcpRequest } from '@electron/features/agent/mcp/mcpServerCore';

export function runAssistantToolRoundTrip(
    name: string,
    args: unknown,
    options: IProcessMcpRequestOptions,
) {
    return processMcpRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
            name,
            arguments: args,
        },
    }, options);
}
