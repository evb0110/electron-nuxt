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
                model: 'gpt-5.6-sol',
                displayName: 'GPT-5.6-Sol Live',
                isDefault: true,
                defaultServiceTier: 'fast',
                serviceTiers: [
                    {
                        id: 'priority',
                        name: 'Fast',
                        description: 'Lower latency',
                    },
                    {
                        id: 'standard',
                        name: 'Standard',
                    },
                ],
                defaultReasoningEffort: 'medium',
                supportedReasoningEfforts: [
                    {
                        reasoningEffort: 'low',
                        description: 'Fast responses',
                    },
                    {
                        reasoningEffort: 'medium',
                        description: 'Balanced responses',
                    },
                    {
                        reasoningEffort: 'xhigh',
                        description: 'Extra high reasoning depth',
                    },
                ],
            },
            {
                id: 'gpt-5.6-terra',
                displayName: 'GPT-5.6-Terra',
                additionalSpeedTiers: ['fast'],
            },
        ]});

        expect(models).toEqual([
            {
                id: 'gpt-5.6-sol',
                label: 'GPT-5.6-Sol Live',
                reasoningEfforts: [
                    {
                        id: 'low',
                        label: 'Low',
                        description: 'Fast responses',
                    },
                    {
                        id: 'medium',
                        label: 'Medium',
                        description: 'Balanced responses',
                        isDefault: true,
                    },
                    {
                        id: 'xhigh',
                        label: 'Extra High',
                        description: 'Extra high reasoning depth',
                    },
                ],
                defaultReasoningEffort: 'medium',
                serviceTiers: [
                    {
                        id: 'priority',
                        label: 'Fast',
                        description: 'Lower latency',
                    },
                    {
                        id: 'standard',
                        label: 'Standard',
                    },
                ],
                defaultServiceTier: 'fast',
                isDefault: true,
            },
            {
                id: 'gpt-5.6-terra',
                label: 'GPT-5.6-Terra',
                serviceTiers: [{
                    id: 'fast',
                    label: 'Fast',
                }],
            },
        ]);
        expect(resolveCodexModelStatus(models ?? [], 'missing-model')).toMatchObject({
            defaultModel: 'gpt-5.6-sol',
            activeModel: 'gpt-5.6-sol',
        });
    });

    it('honors runtime isDefault and keeps default and active inside the model list', () => {
        const models = normalizeCodexModelListResponse({data: [
            {
                model: 'gpt-5.6-sol',
                displayName: 'GPT-5.6-Sol',
            },
            {
                model: 'gpt-5.4',
                displayName: 'GPT-5.4',
                isDefault: true,
            },
        ]}) ?? [];

        const status = resolveCodexModelStatus(models, 'does-not-exist');

        expect(status.defaultModel).toBe('gpt-5.6-sol');
        expect(status.activeModel).toBe('gpt-5.6-sol');
        expect(status.models.map(model => model.id)).toContain(status.defaultModel);
        expect(status.models.map(model => model.id)).toContain(status.activeModel);
        expect(normalizeCodexAssistantModelFromCatalog(models, 'gpt-5.6-sol')).toBe('gpt-5.6-sol');
    });

    it('deduplicates Codex runtime models and ignores blank records', () => {
        expect(normalizeCodexModelListResponse({data: [
            {
                model: 'gpt-5.6-sol',
                displayName: 'GPT-5.6-Sol',
            },
            {
                id: 'gpt-5.6-sol',
                displayName: 'Duplicate',
            },
            {model: '   '},
            null,
            {id: 'gpt-5.4-mini'},
        ]})).toEqual([{
            id: 'gpt-5.6-sol',
            label: 'GPT-5.6-Sol',
        }]);
        expect(normalizeCodexModelListResponse({data: 'bad'})).toBeNull();
    });

    it('removes Codex GPT models below 5.6 from the runtime model catalog', () => {
        expect(normalizeCodexModelListResponse({data: [
            {
                model: 'gpt-5.5',
                displayName: 'GPT-5.5',
                isDefault: true,
            },
            {
                model: 'gpt-5.4-mini',
                displayName: 'GPT-5.4 Mini',
            },
            {
                model: 'gpt-5.3-codex-spark',
                displayName: 'GPT-5.3-Codex-Spark',
            },
            {
                model: 'gpt-5.6-sol',
                displayName: 'GPT-5.6-Sol',
            },
        ]})).toEqual([{
            id: 'gpt-5.6-sol',
            label: 'GPT-5.6-Sol',
        }]);
    });

    it('preserves arbitrary Codex reasoning efforts advertised by model/list', () => {
        const models = normalizeCodexModelListResponse({data: [{
            model: 'gpt-test',
            displayName: 'GPT Test',
            defaultReasoningEffort: 'super-high',
            supportedReasoningEfforts: [
                {
                    reasoningEffort: 'super-high',
                    description: 'Maximum reasoning',
                },
                {reasoningEffort: 'minimal'},
            ],
        }]});

        expect(models?.[0]).toMatchObject({
            id: 'gpt-test',
            reasoningEfforts: [
                {
                    id: 'super-high',
                    label: 'Super High',
                    description: 'Maximum reasoning',
                    isDefault: true,
                },
                {
                    id: 'minimal',
                    label: 'Minimal',
                },
            ],
            defaultReasoningEffort: 'super-high',
        });
    });
});
