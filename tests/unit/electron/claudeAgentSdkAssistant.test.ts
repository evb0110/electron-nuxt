import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ClaudeAgentAssistantSession,
    getClaudeAgentSdkInfo,
    getClaudeAssistantModelLabel,
    normalizeClaudeAssistantModel,
    normalizeClaudeSdkModelList,
    shouldUseClaudeAssistantFastMode,
} from '@electron/features/agent/claudeAgentSdkAssistant';

const sdkMocks = vi.hoisted(() => ({query: vi.fn()}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdkMocks.query }));

vi.mock('electron', () => ({ app: { getVersion: () => 'test' } }));

vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}) }));

class FakeClaudeQuery {
    private readonly messages: unknown[] = [];
    private readonly resolvers: Array<(value: IteratorResult<unknown>) => void> = [];

    readonly accountInfo = vi.fn(async () => null);
    readonly supportedModels = vi.fn(async () => []);
    readonly setModel = vi.fn(async () => undefined);
    readonly interrupt = vi.fn(async () => undefined);
    readonly close = vi.fn(() => {
        while (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift();
            resolve?.({
                value: undefined,
                done: true,
            });
        }
    });

    push(message: unknown) {
        const resolver = this.resolvers.shift();
        if (resolver) {
            resolver({
                value: message,
                done: false,
            });
            return;
        }
        this.messages.push(message);
    }

    [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {next: () => {
            const message = this.messages.shift();
            if (message) {
                return Promise.resolve({
                    value: message,
                    done: false,
                });
            }
            return new Promise<IteratorResult<unknown>>(resolve => this.resolvers.push(resolve));
        }};
    }
}

async function settleAsyncTicks(count = 3) {
    for (let index = 0; index < count; index += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

describe('claudeAgentSdkAssistant', () => {
    beforeEach(() => {
        sdkMocks.query.mockReset();
    });

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

    it('finds user-local Claude CLI when packaged metadata and GUI launch PATH are sparse', async () => {
        const result = await getClaudeAgentSdkInfo({
            env: {
                HOME: '/Users/test',
                PATH: '/usr/bin:/bin',
            },
            resolveSdkPackageDir: () => {
                throw new Error('Cannot find module @anthropic-ai/claude-agent-sdk');
            },
            pathIsExecutable: vi.fn(async path => path === '/Users/test/.local/bin/claude'),
        });

        expect(result).toEqual({
            installed: true,
            version: null,
            executablePath: '/Users/test/.local/bin/claude',
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

    it('includes the active turn id on assistant deltas, messages, and errors', async () => {
        const fakeQuery = new FakeClaudeQuery();
        sdkMocks.query.mockReturnValue(fakeQuery);
        const callbacks = {
            onInitialized: vi.fn(),
            onTurnStarted: vi.fn(),
            onAssistantDelta: vi.fn(),
            onAssistantMessage: vi.fn(),
            onTurnCompleted: vi.fn(),
            onError: vi.fn(),
        };
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'low',
            speedMode: 'standard',
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            callbacks,
        });

        const turnId = await session.sendMessage('Hello', [], 'opus');
        fakeQuery.push({
            type: 'stream_event',
            event: {
                type: 'content_block_delta',
                delta: {
                    type: 'text_delta',
                    text: 'Hi',
                },
            },
        });
        fakeQuery.push({
            type: 'assistant',
            message: { content: [{
                type: 'text',
                text: 'Hi there',
            }] },
        });
        fakeQuery.push({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            result: 'Claude exploded politely.',
        });
        await settleAsyncTicks();

        expect(callbacks.onTurnStarted).toHaveBeenCalledWith(turnId);
        expect(callbacks.onAssistantDelta).toHaveBeenCalledWith(turnId, expect.any(String), 'Hi');
        expect(callbacks.onAssistantMessage).toHaveBeenCalledWith(turnId, expect.any(String), 'Hi there', true);
        expect(callbacks.onError).toHaveBeenCalledWith(turnId, 'Claude exploded politely.');
    });

    it('awaits the consume-stream task when closing a live Claude session', async () => {
        const fakeQuery = new FakeClaudeQuery();
        sdkMocks.query.mockReturnValue(fakeQuery);
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'low',
            speedMode: 'standard',
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            callbacks: {
                onInitialized: vi.fn(),
                onTurnStarted: vi.fn(),
                onAssistantDelta: vi.fn(),
                onAssistantMessage: vi.fn(),
                onTurnCompleted: vi.fn(),
                onError: vi.fn(),
            },
        });

        await session.sendMessage('Hello', [], 'opus');
        const closePromise = session.close();
        expect(fakeQuery.close).toHaveBeenCalledTimes(1);

        await expect(closePromise).resolves.toBeUndefined();
    });
});
