import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    normalizeCodexAssistantModelFromCatalog,
    normalizeCodexModelListResponse,
    resolveCodexModelStatus,
} from '@electron/features/agent/assistantModelCatalog';

describe('agent assistant model catalog', () => {
    it('keeps a runtime-discovered Codex default model and label', () => {
        const models = normalizeCodexModelListResponse({data: [
            {
                model: 'gpt-5.5',
                displayName: 'GPT-5.5 Live',
                isDefault: true,
            },
            {
                id: 'gpt-5.4-mini',
                displayName: 'GPT-5.4 Mini',
            },
        ]});

        expect(models).toEqual([
            {
                id: 'gpt-5.5',
                label: 'GPT-5.5 Live',
                isDefault: true,
            },
            {
                id: 'gpt-5.4-mini',
                label: 'GPT-5.4 Mini',
            },
        ]);
        expect(resolveCodexModelStatus(models ?? [], 'missing-model')).toMatchObject({
            defaultModel: 'gpt-5.5',
            activeModel: 'gpt-5.5',
        });
    });

    it('honors runtime isDefault and keeps default and active inside the model list', () => {
        const models = normalizeCodexModelListResponse({data: [
            {
                model: 'gpt-5.5',
                displayName: 'GPT-5.5',
            },
            {
                model: 'gpt-5.4',
                displayName: 'GPT-5.4',
                isDefault: true,
            },
        ]}) ?? [];

        const status = resolveCodexModelStatus(models, 'does-not-exist');

        expect(status.defaultModel).toBe('gpt-5.4');
        expect(status.activeModel).toBe('gpt-5.4');
        expect(status.models.map(model => model.id)).toContain(status.defaultModel);
        expect(status.models.map(model => model.id)).toContain(status.activeModel);
        expect(normalizeCodexAssistantModelFromCatalog(models, 'gpt-5.5')).toBe('gpt-5.5');
    });

    it('deduplicates Codex runtime models and ignores blank records', () => {
        expect(normalizeCodexModelListResponse({data: [
            {
                model: 'gpt-5.5',
                displayName: 'GPT-5.5',
            },
            {
                id: 'gpt-5.5',
                displayName: 'Duplicate',
            },
            {model: '   '},
            null,
            {id: 'gpt-5.4-mini'},
        ]})).toEqual([
            {
                id: 'gpt-5.5',
                label: 'GPT-5.5',
            },
            {
                id: 'gpt-5.4-mini',
                label: 'gpt-5.4-mini',
            },
        ]);
        expect(normalizeCodexModelListResponse({data: 'bad'})).toBeNull();
    });
});
