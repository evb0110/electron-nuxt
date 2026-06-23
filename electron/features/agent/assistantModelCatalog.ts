import type { IAgentAssistantModelOption } from '@contracts/agent';
import { CODEX_ASSISTANT_DEFAULT_MODEL } from '@contracts/agentModels';
import { isRecord } from '@contracts/runtimeGuards';

export type TCodexAssistantModelOption = IAgentAssistantModelOption & { isDefault?: boolean };

function normalizeCodexModelOption(rawModel: unknown): TCodexAssistantModelOption | null {
    if (!isRecord(rawModel)) {
        return null;
    }

    const id = typeof rawModel.model === 'string' && rawModel.model.trim()
        ? rawModel.model.trim()
        : typeof rawModel.id === 'string' && rawModel.id.trim()
            ? rawModel.id.trim()
            : '';
    if (!id) {
        return null;
    }

    const label = typeof rawModel.displayName === 'string' && rawModel.displayName.trim()
        ? rawModel.displayName.trim()
        : id;
    return {
        id,
        label,
        ...(rawModel.isDefault === true ? {isDefault: true} : {}),
    };
}

export function normalizeCodexModelListResponse(value: unknown) {
    if (!isRecord(value) || !Array.isArray(value.data)) {
        return null;
    }

    const seen = new Set<string>();
    const listedModels = value.data
        .map(normalizeCodexModelOption)
        .filter((model): model is TCodexAssistantModelOption => {
            if (!model || seen.has(model.id)) {
                return false;
            }
            seen.add(model.id);
            return true;
        });
    return listedModels;
}

export function resolveCodexDefaultModelId(models: readonly TCodexAssistantModelOption[]) {
    return models.find(option => option.isDefault)?.id
        ?? models.find(option => option.id === CODEX_ASSISTANT_DEFAULT_MODEL)?.id
        ?? models[0]?.id
        ?? CODEX_ASSISTANT_DEFAULT_MODEL;
}

export function normalizeCodexAssistantModelFromCatalog(
    models: readonly TCodexAssistantModelOption[],
    model: string | null | undefined,
) {
    const fallback = resolveCodexDefaultModelId(models);
    const trimmed = model?.trim();
    if (!trimmed) {
        return fallback;
    }

    return models.some(option => option.id === trimmed)
        ? trimmed
        : fallback;
}

export function resolveCodexModelStatus(
    models: readonly TCodexAssistantModelOption[],
    requestedModel: string | null | undefined,
) {
    return {
        models,
        defaultModel: resolveCodexDefaultModelId(models),
        activeModel: normalizeCodexAssistantModelFromCatalog(models, requestedModel),
    };
}
