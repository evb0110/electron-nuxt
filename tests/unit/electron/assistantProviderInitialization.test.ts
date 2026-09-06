import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const observations = vi.hoisted(() => ({sdkEvaluations: 0}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
    observations.sdkEvaluations += 1;
    return {query: vi.fn()};
});

vi.mock('electron', () => ({app: {
    getVersion: () => 'test',
    isPackaged: false,
}}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

describe('assistant provider initialization boundaries', () => {
    it('keeps SDK-free metadata and status imports separate from the Claude SDK', async () => {
        await import('@electron/features/agent/claudeProviderMetadata');
        await import('@electron/features/agent/assistantProviderStatus');
        expect(observations.sdkEvaluations).toBe(0);

        await import('@electron/features/agent/claudeAgentSdkAssistant');
        expect(observations.sdkEvaluations).toBe(1);
    });
});
