import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    applyCodexAccountReadResponse,
    applyCodexAuthStatusResponse,
    normalizeClaudeAssistantAccount,
    normalizeCodexAssistantAccount,
    refreshCodexAuthState,
    refreshCodexAuthStateAndRuntimeAvailability,
    syncCodexRuntimeStateAfterAuthCheck,
    type ICodexAuthStateClient,
} from '@electron/features/agent/assistantProviderAccounts';
import { createAssistantProviderRuntimeStates } from '@electron/features/agent/assistantProviderState';

function createCodexAuthClient(
    responses: Record<string, unknown | Error>,
): ICodexAuthStateClient {
    return {async requestDecoded(method, _params, decode) {
        const response = responses[method];
        if (response instanceof Error) {
            throw response;
        }
        const decoded = decode(response);
        if (decoded === null) {
            throw new Error(`invalid ${method}`);
        }
        return decoded;
    }};
}

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

    it('applies Codex account read responses before falling back to auth status', () => {
        const states = createAssistantProviderRuntimeStates({codex: {lastError: 'stale'}});
        const codexState = states.codex;

        expect(applyCodexAccountReadResponse(codexState, {account: {
            type: 'chatgpt',
            email: 'reader@example.com',
        }})).toBe(true);
        expect(codexState).toMatchObject({
            authState: 'signed-in',
            account: {
                type: 'chatgpt',
                email: 'reader@example.com',
            },
        });
        expect(codexState.lastError).toBeUndefined();

        codexState.lastError = 'stale again';
        expect(applyCodexAccountReadResponse(codexState, { requiresOpenaiAuth: true })).toBe(true);
        expect(codexState).toMatchObject({
            authState: 'signed-out',
            account: null,
        });
        expect(codexState.lastError).toBeUndefined();

        expect(applyCodexAccountReadResponse(codexState, { account: null })).toBe(false);
    });

    it('refreshes Codex auth from account reads and auth-status fallback', async () => {
        const states = createAssistantProviderRuntimeStates();
        const codexState = states.codex;

        await refreshCodexAuthState(codexState, createCodexAuthClient({
            'account/read': new Error('account/read timed out'),
            getAuthStatus: { authMethod: 'chatgpt' },
        }));
        expect(codexState).toMatchObject({
            authState: 'signed-in',
            account: null,
        });

        await refreshCodexAuthState(codexState, null);
        expect(codexState).toMatchObject({
            authState: 'unknown',
            account: null,
        });
    });

    it('keeps Codex auth refresh failures visible when every probe fails', async () => {
        const states = createAssistantProviderRuntimeStates();
        const codexState = states.codex;
        const warnings: string[] = [];

        await refreshCodexAuthState(codexState, createCodexAuthClient({
            'account/read': new Error('account/read timed out'),
            getAuthStatus: new Error('getAuthStatus timed out'),
        }), {warn: message => warnings.push(message)});

        expect(codexState.authState).toBe('signed-out');
        expect(codexState.account).toBeNull();
        expect(codexState.lastError).toContain('account/read timed out');
        expect(codexState.lastError).toContain('getAuthStatus timed out');
        expect(warnings.join('\n')).toContain('falling back to auth status');
    });

    it('syncs Codex runtime availability after auth checks', async () => {
        const states = createAssistantProviderRuntimeStates({codex: {
            authState: 'signed-in',
            runtimeState: 'error',
        }});
        const codexState = states.codex;

        syncCodexRuntimeStateAfterAuthCheck(codexState, { hasRuntime: true });
        expect(codexState.runtimeState).toBe('error');

        await refreshCodexAuthStateAndRuntimeAvailability({
            providerRuntime: codexState,
            client: createCodexAuthClient({'account/read': {account: {type: 'apiKey'}}}),
            hasRuntime: true,
            recoverFromError: true,
        });
        expect(codexState.runtimeState).toBe('ready');
    });
});
