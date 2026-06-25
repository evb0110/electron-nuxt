import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    applyCodexAuthStatusResponse,
    normalizeClaudeAssistantAccount,
    normalizeCodexAssistantAccount,
} from '@electron/features/agent/assistantProviderAccounts';
import { createAssistantProviderRuntimeStates } from '@electron/features/agent/assistantProviderState';

describe('agent assistant provider accounts', () => {
    it('normalizes Codex account payloads', () => {
        expect(normalizeCodexAssistantAccount({
            type: 'chatgpt',
            email: 'reader@example.com',
            planType: 'plus',
        })).toEqual({
            type: 'chatgpt',
            email: 'reader@example.com',
            planType: 'plus',
        });
        expect(normalizeCodexAssistantAccount({
            type: 'apiKey',
            email: 'ignored@example.com',
        })).toEqual({ type: 'apiKey' });
        expect(normalizeCodexAssistantAccount({ type: 'other-provider' })).toEqual({ type: 'other' });
        expect(normalizeCodexAssistantAccount(null)).toBeNull();
    });

    it('normalizes Claude account payloads into shared account shapes', () => {
        expect(normalizeClaudeAssistantAccount({
            apiProvider: 'anthropic',
            email: 'reader@example.com',
            subscriptionType: 'team',
        })).toEqual({
            type: 'apiKey',
            email: 'reader@example.com',
            planType: 'team',
        });
        expect(normalizeClaudeAssistantAccount({
            email: 'reader@example.com',
            subscriptionType: 'pro',
        })).toEqual({
            type: 'other',
            email: 'reader@example.com',
            planType: 'pro',
        });
        expect(normalizeClaudeAssistantAccount(null)).toBeNull();
    });

    it('applies Codex auth status responses to runtime state', () => {
        const states = createAssistantProviderRuntimeStates({codex: {
            authState: 'unknown',
            runtimeState: 'ready',
            account: { type: 'apiKey' },
            lastError: 'stale auth error',
        }});
        const codexState = states.codex;

        applyCodexAuthStatusResponse(codexState, { authMethod: 'chatgpt' });
        expect(codexState).toMatchObject({
            authState: 'signed-in',
            account: null,
        });
        expect(codexState.lastError).toBeUndefined();

        codexState.lastError = 'another stale auth error';
        applyCodexAuthStatusResponse(codexState, { requiresOpenaiAuth: true });
        expect(codexState).toMatchObject({
            authState: 'signed-out',
            account: null,
        });
        expect(codexState.lastError).toBeUndefined();
    });
});
