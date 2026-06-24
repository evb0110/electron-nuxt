import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    ASSISTANT_DEFAULT_EFFORT,
    ASSISTANT_DEFAULT_SPEED_MODE,
    CLAUDE_ASSISTANT_DEFAULT_MODEL,
    CODEX_ASSISTANT_DEFAULT_MODEL,
    getAssistantPreferredModelId,
} from '@contracts/agentModels';

describe('assistant model defaults', () => {
    it('starts assistant sessions in low-reasoning fast mode', () => {
        expect(ASSISTANT_DEFAULT_EFFORT).toBe('low');
        expect(ASSISTANT_DEFAULT_SPEED_MODE).toBe('fast');
    });

    it('defaults Codex to the first available fallback model', () => {
        expect(CODEX_ASSISTANT_DEFAULT_MODEL).toBe('gpt-5.5');
    });

    it('defaults Claude to the Opus family without hard-coding a versioned id', () => {
        expect(CLAUDE_ASSISTANT_DEFAULT_MODEL).toBe('opus');
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
