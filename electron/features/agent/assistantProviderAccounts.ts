import type { IAgentAssistantAccount } from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';
import type { IAssistantProviderRuntimeState } from '@electron/features/agent/assistantProviderState';

export interface IClaudeAssistantAccountSnapshot {
    apiKeySource?: string | null;
    apiProvider?: string | null;
    email?: string | null;
    subscriptionType?: string | null;
}

export function normalizeCodexAssistantAccount(rawAccount: unknown): IAgentAssistantAccount | null {
    if (!isRecord(rawAccount) || typeof rawAccount.type !== 'string') {
        return null;
    }
    if (rawAccount.type === 'chatgpt') {
        return {
            type: 'chatgpt',
            ...(typeof rawAccount.email === 'string' ? { email: rawAccount.email } : {}),
            ...(typeof rawAccount.planType === 'string' ? { planType: rawAccount.planType } : {}),
        };
    }
    if (rawAccount.type === 'apiKey') {
        return { type: 'apiKey' };
    }
    return { type: 'other' };
}

export function applyCodexAuthStatusResponse(
    providerRuntime: IAssistantProviderRuntimeState,
    authStatus: Record<PropertyKey, unknown>,
) {
    const statusRequiresOpenaiAuth = authStatus.requiresOpenaiAuth === true;
    const hasAuthMethod = authStatus.authMethod != null;
    providerRuntime.authState = statusRequiresOpenaiAuth || !hasAuthMethod
        ? 'signed-out'
        : 'signed-in';
    providerRuntime.account = null;
    if (providerRuntime.authState === 'signed-in' || providerRuntime.authState === 'signed-out') {
        delete providerRuntime.lastError;
    }
}

export function normalizeClaudeAssistantAccount(
    rawAccount: IClaudeAssistantAccountSnapshot | null | undefined,
): IAgentAssistantAccount | null {
    if (!rawAccount) {
        return null;
    }
    if (rawAccount.apiKeySource || rawAccount.apiProvider) {
        return {
            type: 'apiKey',
            ...(rawAccount.email ? { email: rawAccount.email } : {}),
            ...(rawAccount.subscriptionType ? { planType: rawAccount.subscriptionType } : {}),
        };
    }
    return {
        type: 'other',
        ...(rawAccount.email ? { email: rawAccount.email } : {}),
        ...(rawAccount.subscriptionType ? { planType: rawAccount.subscriptionType } : {}),
    };
}
