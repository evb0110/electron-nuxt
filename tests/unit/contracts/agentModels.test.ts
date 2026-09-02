import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    ASSISTANT_DEFAULT_EFFORT,
    ASSISTANT_DEFAULT_SPEED_MODE,
    CLAUDE_ASSISTANT_DEFAULT_MODEL,
    CLAUDE_ASSISTANT_MODELS,
    CODEX_ASSISTANT_DEFAULT_MODEL,
    CODEX_ASSISTANT_FALLBACK_MODELS,
    getAssistantPreferredModelId,
    isRemovedCodexAssistantModelId,
} from '@contracts/agentModels';

describe('assistant model defaults', () => {
    it('starts assistant sessions in low-reasoning fast mode', () => {
        expect(ASSISTANT_DEFAULT_EFFORT).toBe('low');
        expect(ASSISTANT_DEFAULT_SPEED_MODE).toBe('fast');
    });

    it('defaults Codex to the first available fallback model', () => {
        expect(CODEX_ASSISTANT_DEFAULT_MODEL).toBe('gpt-5.6-sol');
    });

    it('identifies Codex GPT model ids below 5.6 independent of casing and whitespace', () => {
        expect(isRemovedCodexAssistantModelId(' GPT-5.5 ')).toBe(true);
        expect(isRemovedCodexAssistantModelId('gpt-5.4-mini')).toBe(true);
        expect(isRemovedCodexAssistantModelId('gpt-5.3-codex-spark')).toBe(true);
        expect(isRemovedCodexAssistantModelId('gpt-4o')).toBe(true);
        expect(isRemovedCodexAssistantModelId('gpt-5.6-sol')).toBe(false);
        expect(isRemovedCodexAssistantModelId('gpt-5.6-terra')).toBe(false);
        expect(isRemovedCodexAssistantModelId('gpt-daybreak-blue-latest')).toBe(false);
    });

    it('keeps only GPT-5.6 and newer models in the static Codex picker fallback', () => {
        expect(CODEX_ASSISTANT_FALLBACK_MODELS.map(model => model.id)).toEqual(['gpt-5.6-sol']);
    });

    it('defaults Claude to the Opus family without hard-coding a versioned id', () => {
        expect(CLAUDE_ASSISTANT_DEFAULT_MODEL).toBe('opus');
        expect(CLAUDE_ASSISTANT_MODELS.slice(0, 3).map(model => model.label)).toEqual([
            'Claude Fable 5.1',
            'Claude Opus 5',
            'Claude Sonnet 5',
        ]);
    });

    it('resolves preferred families from model metadata before using the first model', () => {
        expect(getAssistantPreferredModelId([
            {
                id: 'first-runtime-model',
                label: 'First runtime model',
            },
            {
                id: 'runtime-opus',
                label: 'Runtime Opus 4.9',
            },
        ], 'opus')).toBe('runtime-opus');
    });
});
