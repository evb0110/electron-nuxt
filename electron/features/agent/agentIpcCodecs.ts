import type {
    IAgentAssistantScopedRequest,
    IAgentAssistantSendMessageRequest,
    IAgentAssistantStateRequest,
    IAgentCommandResponse,
    IAgentMcpIntegrationStatus,
    IAgentRendererAck,
    IAgentWorkspaceSnapshot,
    IAgentWorkspaceSnapshotResponse,
} from '@contracts/agent';
import {
    AGENT_ASSISTANT_PRESET_IDS,
    ASSISTANT_PROVIDER_IDS,
} from '@contracts/agent';
import type { TIpcCodecMap } from '@contracts/ipcMain';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    AGENT_CHANNELS,
    type IAgentInvokeMap,
} from '@electron/features/agent/contract';
import {
    decodeAgentAssistantChatScope,
    decodeAgentAssistantImageAttachment,
    decodeAgentAssistantInstallResult,
    decodeAgentAssistantLoginResult,
    decodeAgentAssistantSendMessageResult,
    decodeAgentAssistantState,
} from '@electron/preload/agentIpcDecoders';
import {
    decodeBooleanArg,
    decodeBoundedArray,
} from '@electron/platform-ipc/ipcArgumentValidation';
import {
    decodeNoArgs,
    requireIpcArgumentCount,
    requireDecoded,
} from '@electron/platform-ipc/ipcCodecValidation';

function decodeOptionalSelection(value: Record<PropertyKey, unknown>): Pick<IAgentAssistantStateRequest, 'provider' | 'model' | 'effort' | 'speedMode'> {
    if (
        value.provider !== undefined && !isOneOf(ASSISTANT_PROVIDER_IDS, value.provider)
        || value.model !== undefined && typeof value.model !== 'string'
        || value.effort !== undefined && typeof value.effort !== 'string'
        || value.speedMode !== undefined && value.speedMode !== 'fast' && value.speedMode !== 'standard'
    ) {
        throw new Error('invalid assistant selection');
    }
    const selection: Pick<IAgentAssistantStateRequest, 'provider' | 'model' | 'effort' | 'speedMode'> = {
        ...(value.provider === undefined ? {} : {provider: value.provider}),
        ...(value.model === undefined ? {} : {model: value.model}),
        ...(value.effort === undefined ? {} : {effort: value.effort}),
        ...(value.speedMode === undefined ? {} : {speedMode: value.speedMode}),
    };
    return selection;
}

function decodeOptionalScope(value: unknown) {
    if (value === undefined || value === null) {
        return value;
    }
    const scope = decodeAgentAssistantChatScope(value);
    if (scope === null) {
        throw new Error('invalid assistant scope');
    }
    return scope;
}

function decodeAssistantStateRequest(value: unknown): IAgentAssistantStateRequest | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new Error('assistant state request must be an object');
    }
    const scope = decodeOptionalScope(value.scope);
    return {
        ...decodeOptionalSelection(value),
        ...(scope === undefined ? {} : {scope}),
    };
}

function decodeAssistantScopedRequest(value: unknown): IAgentAssistantScopedRequest | undefined {
    return decodeAssistantStateRequest(value);
}

function decodeAssistantSendMessageRequest(value: unknown): IAgentAssistantSendMessageRequest {
    if (!isRecord(value) || typeof value.text !== 'string') {
        throw new Error('assistant message request must include text');
    }
    const scope = decodeOptionalScope(value.scope);
    let attachments;
    if (value.attachments !== undefined) {
        attachments = decodeBoundedArray(value.attachments, 'assistant attachments', {
            allowEmpty: true,
            maxItems: 64,
        }).map((attachment) => {
            const decoded = decodeAgentAssistantImageAttachment(attachment);
            if (decoded === null) {
                throw new Error('invalid assistant image attachment');
            }
            return decoded;
        });
    }
    if (value.presetId !== undefined && !isOneOf(AGENT_ASSISTANT_PRESET_IDS, value.presetId)) {
        throw new Error('invalid assistant preset');
    }
    return {
        text: value.text,
        ...decodeOptionalSelection(value),
        ...(scope === undefined ? {} : {scope}),
        ...(attachments === undefined ? {} : {attachments}),
        ...(value.presetId === undefined ? {} : {presetId: value.presetId}),
    };
}

function isWorkspaceSnapshot(value: unknown): value is IAgentWorkspaceSnapshot {
    return isRecord(value)
        && typeof value.capturedAt === 'string'
        && (value.activePaneId === null || typeof value.activePaneId === 'string')
        && (value.activeTabId === null || typeof value.activeTabId === 'string')
        && isRecord(value.summary)
        && Array.isArray(value.panes) && value.panes.length <= 10_000
        && Array.isArray(value.tabs) && value.tabs.length <= 10_000
        && Array.isArray(value.recentFiles) && value.recentFiles.length <= 10_000
        && (value.layout === null || isRecord(value.layout));
}

function decodeWorkspaceSnapshotResponse(value: unknown): IAgentWorkspaceSnapshotResponse {
    if (
        !isRecord(value)
        || typeof value.requestId !== 'string'
        || typeof value.ok !== 'boolean'
        || (value.windowId !== undefined && (typeof value.windowId !== 'number' || !Number.isSafeInteger(value.windowId)))
        || (value.revision !== undefined && (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision)))
        || (value.unchanged !== undefined && typeof value.unchanged !== 'boolean')
        || (value.snapshot !== undefined && !isWorkspaceSnapshot(value.snapshot))
        || (value.error !== undefined && typeof value.error !== 'string')
    ) {
        throw new Error('invalid workspace snapshot response');
    }
    return {
        requestId: value.requestId,
        ok: value.ok,
        ...(value.windowId === undefined ? {} : {windowId: value.windowId}),
        ...(value.snapshot === undefined ? {} : {snapshot: value.snapshot}),
        ...(value.revision === undefined ? {} : {revision: value.revision}),
        ...(value.unchanged === undefined ? {} : {unchanged: value.unchanged}),
        ...(value.error === undefined ? {} : {error: value.error}),
    };
}

function decodeCommandResponse(value: unknown): IAgentCommandResponse {
    if (
        !isRecord(value)
        || typeof value.requestId !== 'string'
        || typeof value.ok !== 'boolean'
        || (value.windowId !== undefined && (typeof value.windowId !== 'number' || !Number.isSafeInteger(value.windowId)))
        || (value.result !== undefined && !isRecord(value.result))
        || (value.error !== undefined && typeof value.error !== 'string')
    ) {
        throw new Error('invalid agent command response');
    }
    return {
        requestId: value.requestId,
        ok: value.ok,
        ...(value.windowId === undefined ? {} : {windowId: value.windowId}),
        ...(value.result === undefined ? {} : {result: value.result}),
        ...(value.error === undefined ? {} : {error: value.error}),
    };
}

function decodeMcpStatus(value: unknown): IAgentMcpIntegrationStatus {
    if (
        !isRecord(value)
        || typeof value.enabled !== 'boolean'
        || typeof value.serverName !== 'string'
        || typeof value.serverUrl !== 'string'
        || typeof value.serverRunning !== 'boolean'
        || typeof value.codexInstalled !== 'boolean'
        || (value.codexPath !== null && typeof value.codexPath !== 'string')
        || typeof value.codexConfigured !== 'boolean'
        || (
            value.codexRegistrationState !== 'configured'
            && value.codexRegistrationState !== 'missing'
            && value.codexRegistrationState !== 'mismatched'
            && value.codexRegistrationState !== 'unknown'
        )
        || typeof value.installUrl !== 'string'
        || typeof value.lastCheckedAt !== 'string'
        || (value.error !== undefined && typeof value.error !== 'string')
    ) {
        throw new Error('invalid agent MCP status');
    }
    const setupSnippets = value.setupSnippets;
    let decodedSetupSnippets: IAgentMcpIntegrationStatus['setupSnippets'];
    if (
        setupSnippets !== undefined
        && (
            !isRecord(setupSnippets)
            || typeof setupSnippets.codex !== 'string'
            || typeof setupSnippets.claude !== 'string'
            || typeof setupSnippets.cursor !== 'string'
        )
    ) {
        throw new Error('invalid agent MCP setup snippets');
    }
    if (isRecord(setupSnippets)) {
        decodedSetupSnippets = {
            codex: setupSnippets.codex as string,
            claude: setupSnippets.claude as string,
            cursor: setupSnippets.cursor as string,
        };
    }
    return {
        enabled: value.enabled,
        serverName: value.serverName,
        serverUrl: value.serverUrl,
        serverRunning: value.serverRunning,
        codexInstalled: value.codexInstalled,
        codexPath: value.codexPath,
        codexConfigured: value.codexConfigured,
        codexRegistrationState: value.codexRegistrationState,
        installUrl: value.installUrl,
        lastCheckedAt: value.lastCheckedAt,
        ...(decodedSetupSnippets === undefined ? {} : {setupSnippets: decodedSetupSnippets}),
        ...(value.error === undefined ? {} : {error: value.error}),
    };
}

function decodeMcpUpdateResult(value: unknown) {
    if (
        !isRecord(value)
        || typeof value.ok !== 'boolean'
        || (value.cancelled !== undefined && typeof value.cancelled !== 'boolean')
        || (value.error !== undefined && typeof value.error !== 'string')
    ) {
        throw new Error('invalid agent MCP update result');
    }
    return {
        ok: value.ok,
        ...(value.cancelled === undefined ? {} : {cancelled: value.cancelled}),
        status: decodeMcpStatus(value.status),
        ...(value.error === undefined ? {} : {error: value.error}),
    };
}

function decodeRendererAck(value: unknown): IAgentRendererAck {
    if (
        !isRecord(value)
        || typeof value.accepted !== 'boolean'
        || (
            value.reason !== undefined
            && value.reason !== 'invalid-payload'
            && value.reason !== 'unexpected-sender'
            && value.reason !== 'unknown-request'
        )
    ) {
        throw new Error('invalid agent renderer acknowledgement');
    }
    const reason: IAgentRendererAck['reason'] = value.reason;
    return {
        accepted: value.accepted,
        ...(reason === undefined ? {} : {reason}),
    };
}

function decodeOptionalRequestArgs<T>(
    args: readonly unknown[],
    decode: (value: unknown) => T | undefined,
): [request?: T] {
    requireIpcArgumentCount(args, {
        min: 0,
        max: 1,
    });
    const request = decode(args[0]);
    return request === undefined ? [] : [request];
}

export const AGENT_IPC_CODECS = {
    [AGENT_CHANNELS.getMcpIntegrationStatus]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodeMcpStatus,
    },
    [AGENT_CHANNELS.setMcpIntegrationEnabled]: {
        decodeArgs: (args: readonly unknown[]) => {
            requireIpcArgumentCount(args, 1);
            return [decodeBooleanArg(args, 0, 'enabled')];
        },
        decodeResult: decodeMcpUpdateResult,
    },
    [AGENT_CHANNELS.getAssistantState]: {
        decodeArgs: (args: readonly unknown[]) => decodeOptionalRequestArgs(args, decodeAssistantStateRequest),
        decodeResult: (value: unknown) => requireDecoded(value, decodeAgentAssistantState, 'assistant state'),
    },
    [AGENT_CHANNELS.installAssistantCodex]: {
        decodeArgs: decodeNoArgs,
        decodeResult: (value: unknown) => requireDecoded(value, decodeAgentAssistantInstallResult, 'assistant install'),
    },
    [AGENT_CHANNELS.startAssistantLogin]: {
        decodeArgs: (args: readonly unknown[]) => {
            requireIpcArgumentCount(args, 1);
            if (!isRecord(args[0]) || (args[0].mode !== 'chatgpt' && args[0].mode !== 'device-code')) {
                throw new Error('invalid assistant login request');
            }
            return [{mode: args[0].mode}];
        },
        decodeResult: (value: unknown) => requireDecoded(value, decodeAgentAssistantLoginResult, 'assistant login'),
    },
    [AGENT_CHANNELS.cancelAssistantLogin]: {
        decodeArgs: decodeNoArgs,
        decodeResult: (value: unknown) => requireDecoded(value, decodeAgentAssistantState, 'assistant state'),
    },
    [AGENT_CHANNELS.sendAssistantMessage]: {
        decodeArgs: (args: readonly unknown[]) => {
            requireIpcArgumentCount(args, 1);
            return [decodeAssistantSendMessageRequest(args[0])];
        },
        decodeResult: (value: unknown) => requireDecoded(value, decodeAgentAssistantSendMessageResult, 'assistant message'),
    },
    [AGENT_CHANNELS.interruptAssistant]: {
        decodeArgs: (args: readonly unknown[]) => decodeOptionalRequestArgs(args, decodeAssistantScopedRequest),
        decodeResult: (value: unknown) => requireDecoded(value, decodeAgentAssistantState, 'assistant state'),
    },
    [AGENT_CHANNELS.resetAssistantChat]: {
        decodeArgs: (args: readonly unknown[]) => decodeOptionalRequestArgs(args, decodeAssistantScopedRequest),
        decodeResult: (value: unknown) => requireDecoded(value, decodeAgentAssistantState, 'assistant state'),
    },
    [AGENT_CHANNELS.submitWorkspaceSnapshot]: {
        decodeArgs: (args: readonly unknown[]) => {
            requireIpcArgumentCount(args, 1);
            return [decodeWorkspaceSnapshotResponse(args[0])];
        },
        decodeResult: decodeRendererAck,
    },
    [AGENT_CHANNELS.submitCommandResponse]: {
        decodeArgs: (args: readonly unknown[]) => {
            requireIpcArgumentCount(args, 1);
            return [decodeCommandResponse(args[0])];
        },
        decodeResult: decodeRendererAck,
    },
} satisfies TIpcCodecMap<IAgentInvokeMap>;
