import type { IAgentAssistantAccount } from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';
import type { IAssistantProviderRuntimeState } from '@electron/features/agent/assistantProviderState';
import { getErrorMessage } from '@electron/utils/error';

const CODEX_AUTH_ACCOUNT_READ_TIMEOUT_MS = 8_000;
const CODEX_AUTH_STATUS_TIMEOUT_MS = 8_000;

export interface IClaudeAssistantAccountSnapshot {
    apiKeySource?: string | null;
    apiProvider?: string | null;
    email?: string | null;
    subscriptionType?: string | null;
}

export interface ICodexAuthStateClient {requestDecoded<T>(
    method: string,
    params: unknown,
    decode: (value: unknown) => T | null,
    timeoutMs?: number,
): Promise<T>;}

export interface ICodexAuthRefreshOptions {
    info?: (message: string) => void;
    warn?: (message: string) => void;
}

export interface ICodexAuthRuntimeAvailabilityOptions extends ICodexAuthRefreshOptions {
    client: ICodexAuthStateClient | null;
    hasRuntime: boolean;
    providerRuntime: IAssistantProviderRuntimeState;
    recoverFromError?: boolean;
}

function decodeRecordResponse(value: unknown): Record<PropertyKey, unknown> | null {
    return isRecord(value) ? value : null;
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

export function applyCodexAccountReadResponse(
    providerRuntime: IAssistantProviderRuntimeState,
    accountResponse: Record<PropertyKey, unknown>,
) {
    const normalizedAccount = normalizeCodexAssistantAccount(accountResponse.account);
    if (normalizedAccount) {
        providerRuntime.authState = 'signed-in';
        providerRuntime.account = normalizedAccount;
        delete providerRuntime.lastError;
        return true;
    }

    if (accountResponse.requiresOpenaiAuth === true) {
        providerRuntime.authState = 'signed-out';
        providerRuntime.account = null;
        delete providerRuntime.lastError;
        return true;
    }

    return false;
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

export async function refreshCodexAuthState(
    providerRuntime: IAssistantProviderRuntimeState,
    client: ICodexAuthStateClient | null,
    options: ICodexAuthRefreshOptions = {},
) {
    if (!client) {
        providerRuntime.authState = 'unknown';
        providerRuntime.account = null;
        return;
    }

    let accountReadError: unknown;
    try {
        const accountResponse = await client.requestDecoded(
            'account/read',
            { refreshToken: true },
            decodeRecordResponse,
            CODEX_AUTH_ACCOUNT_READ_TIMEOUT_MS,
        );
        if (applyCodexAccountReadResponse(providerRuntime, accountResponse)) {
            return;
        }
    } catch (error) {
        accountReadError = error;
    }

    try {
        const authStatus = await client.requestDecoded(
            'getAuthStatus',
            {
                includeToken: false,
                refreshToken: accountReadError === undefined,
            },
            decodeRecordResponse,
            CODEX_AUTH_STATUS_TIMEOUT_MS,
        );
        applyCodexAuthStatusResponse(providerRuntime, authStatus);
        if (accountReadError !== undefined) {
            options.info?.(`Codex account profile was unavailable; auth status fallback succeeded: ${getErrorMessage(accountReadError)}`);
        }
    } catch (error) {
        const message = accountReadError === undefined
            ? getErrorMessage(error)
            : `${getErrorMessage(accountReadError)}; ${getErrorMessage(error)}`;
        options.warn?.(`Failed to read Codex auth state: ${message}`);
        providerRuntime.authState = providerRuntime.authState === 'signed-in' ? 'signed-in' : 'signed-out';
        providerRuntime.account = null;
        if (providerRuntime.authState !== 'signed-in') {
            providerRuntime.lastError = `Could not verify Codex authentication: ${message}`;
        }
    }
}

export function syncCodexRuntimeStateAfterAuthCheck(
    providerRuntime: IAssistantProviderRuntimeState,
    options: {
        hasRuntime: boolean;
        recoverFromError?: boolean
    },
) {
    if (!options.hasRuntime || providerRuntime.runtimeState === 'busy') {
        return;
    }
    if (providerRuntime.runtimeState === 'error' && !options.recoverFromError) {
        return;
    }

    providerRuntime.runtimeState = providerRuntime.authState === 'signed-in' ? 'ready' : 'stopped';
}

export async function refreshCodexAuthStateAndRuntimeAvailability(
    options: ICodexAuthRuntimeAvailabilityOptions,
) {
    await refreshCodexAuthState(
        options.providerRuntime,
        options.client,
        {
            ...(options.info ? {info: options.info} : {}),
            ...(options.warn ? {warn: options.warn} : {}),
        },
    );
    syncCodexRuntimeStateAfterAuthCheck(options.providerRuntime, {
        hasRuntime: options.hasRuntime,
        ...(options.recoverFromError === undefined ? {} : { recoverFromError: options.recoverFromError }),
    });
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
