import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    getClaudeAgentSdkInfo,
    getClaudeAssistantModelLabel,
    normalizeClaudeAssistantModel,
    normalizeClaudeSdkModelList,
    shouldUseClaudeAssistantFastMode,
} from '@electron/features/agent/claudeAgentSdkAssistant';

vi.mock('electron', () => ({ app: { getVersion: () => 'test' } }));

vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}) }));

describe('claudeAgentSdkAssistant', () => {
    it('keeps full versioned Claude model ids and labels known ids', () => {
        expect(normalizeClaudeAssistantModel('claude-opus-4-8')).toBe('claude-opus-4-8');
        expect(normalizeClaudeAssistantModel(' claude-fable-5 ')).toBe('claude-fable-5');
        expect(normalizeClaudeAssistantModel('global.anthropic.claude-fable-5')).toBe('global.anthropic.claude-fable-5');
        expect(normalizeClaudeAssistantModel('anthropic.claude-fable-5')).toBe('fable');
        expect(getClaudeAssistantModelLabel('claude-opus-4-8')).toBe('Claude Opus 4.8');
    });

    it('enables Claude fast mode only for Opus-family models', () => {
        expect(shouldUseClaudeAssistantFastMode('opus', 'fast')).toBe(true);
        expect(shouldUseClaudeAssistantFastMode('claude-opus-4-8', 'fast')).toBe(true);
        expect(shouldUseClaudeAssistantFastMode('global.anthropic.claude-opus-4-8', 'fast')).toBe(true);
        expect(shouldUseClaudeAssistantFastMode('claude-sonnet-4-6', 'fast')).toBe(false);
        expect(shouldUseClaudeAssistantFastMode('claude-opus-4-8', 'standard')).toBe(false);
    });

    it('normalizes Claude SDK supportedModels metadata', () => {
        expect(normalizeClaudeSdkModelList([
            {
                value: 'claude-fable-5',
                displayName: 'Claude Fable 5 Runtime',
                description: 'Highest capability',
            },
            {
                value: 'claude-fable-5',
                displayName: 'Duplicate',
            },
            {
                value: 'claude-sonnet-4-6',
                displayName: '',
            },
            {
                value: '',
                displayName: 'Blank',
            },
        ])).toEqual([
            {
                id: 'claude-fable-5',
                label: 'Claude Fable 5 Runtime',
            },
            {
                id: 'claude-sonnet-4-6',
                label: 'Claude Sonnet 4.6',
            },
        ]);
        expect(normalizeClaudeSdkModelList({data: []})).toEqual([]);
    });

    it('does not fail setup when SDK package metadata is missing but env CLI exists', async () => {
        const result = await getClaudeAgentSdkInfo({
            env: {CLAUDE_CODE_PATH: '/opt/claude/bin/claude'},
            resolveSdkPackageDir: () => {
                throw new Error('Cannot find module @anthropic-ai/claude-agent-sdk');
            },
            findClaudeOnPath: vi.fn(async () => null),
            pathIsExecutable: vi.fn(async path => path === '/opt/claude/bin/claude'),
        });

        expect(result).toEqual({
            installed: true,
            version: null,
            executablePath: '/opt/claude/bin/claude',
        });
    });

    it('reports an actionable missing Claude CLI error when package metadata is unavailable', async () => {
        const result = await getClaudeAgentSdkInfo({
            env: {},
            resolveSdkPackageDir: () => {
                throw new Error('Cannot find module @anthropic-ai/claude-agent-sdk');
            },
            findClaudeOnPath: vi.fn(async () => null),
            pathIsExecutable: vi.fn(async () => false),
        });

        expect(result).toEqual({
            installed: false,
            version: null,
            executablePath: null,
            error: 'Claude Code executable was not found. Install Claude Code or set CLAUDE_CODE_PATH to a local claude executable.',
        });
    });
});
