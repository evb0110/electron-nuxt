import type {
    SDKAssistantMessage,
    SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { IAgentAssistantTokenUsage } from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';

export interface IClaudeAssistantToolActivity {
    toolId: string;
    name: string;
    phase: 'running' | 'completed' | 'failed';
}

export function extractAssistantToolUses(message: SDKAssistantMessage) {
    const content = message.message.content;
    if (!Array.isArray(content)) {
        return [];
    }
    return content.flatMap((block): IClaudeAssistantToolActivity[] => {
        if (!isRecord(block) || block.type !== 'tool_use' || typeof block.id !== 'string') {
            return [];
        }
        return [{
            toolId: block.id,
            name: typeof block.name === 'string' && block.name.trim() ? block.name : 'tool',
            phase: 'running',
        }];
    });
}

export function extractClaudeTokenUsage(message: SDKResultMessage): IAgentAssistantTokenUsage {
    const usage = message.usage;
    const cachedInputTokens = usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
    return {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        ...(cachedInputTokens > 0 ? {cachedInputTokens} : {}),
    };
}
