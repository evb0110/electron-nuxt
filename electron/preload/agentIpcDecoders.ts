import type {
    IAgentAssistantAccount,
    IAgentAssistantChatScope,
    IAgentAssistantChatMessage,
    IAgentAssistantEffortOption,
    IAgentAssistantErrorEnvelope,
    IAgentAssistantImageAttachment,
    IAgentAssistantInstallResult,
    IAgentAssistantLoginResult,
    IAgentAssistantMcpStatus,
    IAgentAssistantModelOption,
    IAgentAssistantProviderStatus,
    IAgentAssistantSendMessageResult,
    IAgentAssistantServiceTierOption,
    IAgentCommandExecutionScope,
    IAgentAssistantState,
    IAgentAssistantStatus,
    IAgentAssistantTurnState,
    TAgentCommand,
    TAgentWorkspaceCommandTarget,
} from '@contracts/agent';
import {
    AGENT_ASSISTANT_ERROR_CODES,
    AGENT_ASSISTANT_EVENT_TYPES,
    AGENT_ASSISTANT_MESSAGE_ROLES,
    AGENT_ASSISTANT_TURN_PHASES,
    ASSISTANT_PROVIDER_IDS,
} from '@contracts/agent';
import type { TDocumentBackend } from '@contracts/documentRef';
import {
    isDocumentRevisionInfo,
    parseDocumentRevisionToken,
} from '@contracts/documentRevision';
import { parseDocumentInstanceId } from '@contracts/documentInstanceId';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import type { IAgentEventMap } from '@electron/features/agent/contract';

const AGENT_ASSISTANT_INSTALL_STATES = [
    'installed',
    'missing',
    'unsupported',
] as const;
const AGENT_ASSISTANT_AUTH_STATES = [
    'signed-in',
    'signed-out',
    'login-pending',
    'unknown',
] as const;
const AGENT_ASSISTANT_RUNTIME_STATES = [
    'stopped',
    'starting',
    'ready',
    'busy',
    'error',
] as const;
const AGENT_ASSISTANT_MODEL_SWITCH_MODES = [
    'none',
    'in-session',
] as const;
const AGENT_ASSISTANT_SPEED_MODES = [
    'fast',
    'standard',
] as const;

function normalizeNonEmptyString(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalWindowId(value: unknown) {
    if (value === undefined) {
        return undefined;
    }
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : null;
}

function normalizeOptionalRevision(value: unknown) {
    if (value === undefined) {
        return undefined;
    }
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : null;
}

function normalizeOptionalTabId(value: unknown) {
    if (value === undefined || value === null) {
        return undefined;
    }
    return normalizeNonEmptyString(value);
}

function normalizeOptionalDocumentRef(value: unknown) {
    if (value === undefined || value === null) {
        return null;
    }
    return normalizeNonEmptyString(value);
}

function normalizeNullableDocumentRef(value: unknown) {
    if (value === null) {
        return null;
    }

    return normalizeNonEmptyString(value);
}

function normalizeOptionalDocumentBackend(value: unknown): TDocumentBackend | null | undefined {
    if (value === undefined) {
        return undefined;
    }
    return value === 'browser' || value === 'electron'
        ? value
        : null;
}

function normalizeOptionalDocumentRevisionToken(value: unknown) {
    if (value === undefined) {
        return undefined;
    }

    return parseDocumentRevisionToken(value);
}

function normalizeOptionalDocumentInstanceId(value: unknown) {
    if (value === undefined || value === null) {
        return null;
    }

    return parseDocumentInstanceId(value);
}

function decodeCommandTargetBase(value: Record<PropertyKey, unknown>) {
    const tabId = normalizeNonEmptyString(value.tabId);
    const sessionId = normalizeNonEmptyString(value.sessionId);
    const documentRef = normalizeNullableDocumentRef(value.documentRef);
    const documentBackend = normalizeOptionalDocumentBackend(value.documentBackend);
    const documentInstanceId = normalizeOptionalDocumentInstanceId(value.documentInstanceId);
    const documentRevisionToken = normalizeOptionalDocumentRevisionToken(value.documentRevisionToken);
    if (
        tabId === null
        || sessionId === null
        || documentRef === null && value.documentRef !== null
        || documentBackend === null
        || documentInstanceId === null && value.documentInstanceId !== null && value.documentInstanceId !== undefined
        || documentRevisionToken === null
    ) {
        return null;
    }

    return {
        tabId,
        sessionId,
        documentRef,
        ...(documentBackend === undefined ? {} : {documentBackend}),
        documentInstanceId,
        ...(documentRevisionToken === undefined ? {} : {documentRevisionToken}),
    };
}

function decodeWorkspaceCommandTarget(value: unknown): TAgentWorkspaceCommandTarget | null | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        return null;
    }

    const base = decodeCommandTargetBase(value);
    if (!base) {
        return null;
    }

    if (value.kind === 'transaction') {
        const transactionId = normalizeNonEmptyString(value.transactionId);
        return transactionId === null
            ? null
            : {
                kind: 'transaction',
                ...base,
                transactionId,
            };
    }

    if (value.kind === 'revision') {
        const sessionRevision = normalizeOptionalRevision(value.sessionRevision);
        return sessionRevision === undefined || sessionRevision === null
            ? null
            : {
                kind: 'revision',
                ...base,
                sessionRevision,
            };
    }

    return null;
}

function decodeCommandExecutionScope(value: unknown): IAgentCommandExecutionScope | null | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        return null;
    }

    const windowId = normalizeOptionalWindowId(value.windowId);
    const tabId = normalizeNonEmptyString(value.tabId);
    const documentRef = normalizeOptionalDocumentRef(value.documentRef);
    const documentBackend = normalizeOptionalDocumentBackend(value.documentBackend);
    const documentInstanceId = normalizeOptionalDocumentInstanceId(value.documentInstanceId);
    const documentIdentity = value.documentIdentity === undefined || value.documentIdentity === null
        ? null
        : isDocumentRevisionInfo(value.documentIdentity)
            ? value.documentIdentity
            : undefined;
    const commandTarget = decodeWorkspaceCommandTarget(value.commandTarget);
    if (
        windowId === undefined
        || windowId === null
        || tabId === null
        || documentRef === null
        || documentBackend === null
        || documentInstanceId === null && value.documentInstanceId !== null && value.documentInstanceId !== undefined
        || documentIdentity === undefined
        || commandTarget === null
    ) {
        return null;
    }

    return {
        windowId,
        tabId,
        documentRef,
        ...(documentBackend === undefined ? {} : {documentBackend}),
        documentInstanceId,
        documentIdentity,
        ...(commandTarget === undefined ? {} : {commandTarget}),
    };
}

function decodeAgentCommand(value: unknown): TAgentCommand | null {
    if (!isRecord(value) || !isRecord(value.arguments)) {
        return null;
    }

    if (value.name === 'activate_tab') {
        const tabId = normalizeNonEmptyString(value.arguments.tabId);
        return tabId === null
            ? null
            : {
                name: 'activate_tab',
                arguments: {tabId},
            };
    }

    if (value.name === 'go_to_page') {
        const page = value.arguments.page;
        const tabId = normalizeOptionalTabId(value.arguments.tabId);
        if (
            typeof page !== 'number'
            || !Number.isFinite(page)
            || page <= 0
            || tabId === null
        ) {
            return null;
        }
        return {
            name: 'go_to_page',
            arguments: {
                page,
                ...(tabId === undefined ? {} : {tabId}),
            },
        };
    }

    if (value.name === 'run_action') {
        const id = normalizeNonEmptyString(value.arguments.id);
        const tabId = normalizeOptionalTabId(value.arguments.tabId);
        const input = value.arguments.input;
        const dryRun = value.arguments.dryRun;
        if (
            id === null
            || tabId === null
            || (input !== undefined && !isRecord(input))
            || (dryRun !== undefined && typeof dryRun !== 'boolean')
        ) {
            return null;
        }
        return {
            name: 'run_action',
            arguments: {
                id,
                ...(tabId === undefined ? {} : {tabId}),
                ...(input === undefined ? {} : {input}),
                ...(dryRun === undefined ? {} : {dryRun}),
            },
        };
    }

    if (value.name === 'read_resource') {
        const uri = normalizeNonEmptyString(value.arguments.uri);
        const tabId = normalizeOptionalTabId(value.arguments.tabId);
        if (uri === null || tabId === null) {
            return null;
        }
        return {
            name: 'read_resource',
            arguments: {
                uri,
                ...(tabId === undefined ? {} : {tabId}),
            },
        };
    }

    return null;
}

function isAssistantEventType(value: unknown): value is typeof AGENT_ASSISTANT_EVENT_TYPES[number] {
    return isOneOf(AGENT_ASSISTANT_EVENT_TYPES, value);
}

function isAssistantMessageRole(value: unknown): value is typeof AGENT_ASSISTANT_MESSAGE_ROLES[number] {
    return isOneOf(AGENT_ASSISTANT_MESSAGE_ROLES, value);
}

function isAssistantErrorCode(value: unknown): value is typeof AGENT_ASSISTANT_ERROR_CODES[number] {
    return isOneOf(AGENT_ASSISTANT_ERROR_CODES, value);
}

function decodeArray<T>(value: unknown, decode: (item: unknown) => T | null): T[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const decoded: T[] = [];
    for (const item of value) {
        const result = decode(item);
        if (result === null) {
            return null;
        }
        decoded.push(result);
    }
    return decoded;
}

function decodeStringArray(value: unknown) {
    return Array.isArray(value) && value.every(item => typeof item === 'string')
        ? [...value]
        : null;
}

function decodeAssistantErrorEnvelope(value: unknown): IAgentAssistantErrorEnvelope | null {
    if (
        !isRecord(value)
        || !isAssistantErrorCode(value.code)
        || typeof value.message !== 'string'
        || typeof value.retryable !== 'boolean'
        || typeof value.timestamp !== 'number'
        || !Number.isFinite(value.timestamp)
    ) {
        return null;
    }

    return {
        code: value.code,
        message: value.message,
        retryable: value.retryable,
        timestamp: value.timestamp,
    };
}

export function decodeAgentAssistantImageAttachment(value: unknown): IAgentAssistantImageAttachment | null {
    if (
        !isRecord(value)
        || value.type !== 'image'
        || typeof value.id !== 'string'
        || typeof value.name !== 'string'
        || typeof value.mimeType !== 'string'
        || typeof value.dataUrl !== 'string'
        || typeof value.sizeBytes !== 'number'
        || !Number.isFinite(value.sizeBytes)
        || value.sizeBytes <= 0
    ) {
        return null;
    }

    return {
        type: 'image',
        id: value.id,
        name: value.name,
        mimeType: value.mimeType,
        sizeBytes: value.sizeBytes,
        dataUrl: value.dataUrl,
    };
}

function decodeAssistantMessage(value: unknown): IAgentAssistantChatMessage | null {
    if (!isRecord(value)) {
        return null;
    }

    const errorEnvelope = value.errorEnvelope === undefined
        ? undefined
        : decodeAssistantErrorEnvelope(value.errorEnvelope);
    if (
        typeof value.id !== 'string'
        || !isAssistantMessageRole(value.role)
        || typeof value.text !== 'string'
        || typeof value.createdAt !== 'string'
        || (value.pending !== undefined && typeof value.pending !== 'boolean')
        || (value.error !== undefined && typeof value.error !== 'string')
        || (value.errorEnvelope !== undefined && errorEnvelope === null)
    ) {
        return null;
    }

    let attachments: IAgentAssistantImageAttachment[] | undefined;
    if (value.attachments !== undefined) {
        if (!Array.isArray(value.attachments)) {
            return null;
        }
        attachments = [];
        for (const attachment of value.attachments) {
            const decoded = decodeAgentAssistantImageAttachment(attachment);
            if (decoded === null) {
                return null;
            }
            attachments.push(decoded);
        }
    }

    const message: IAgentAssistantChatMessage = {
        id: value.id,
        role: value.role,
        text: value.text,
        createdAt: value.createdAt,
    };
    if (attachments !== undefined) {
        message.attachments = attachments;
    }
    if (value.pending !== undefined) {
        message.pending = value.pending;
    }
    if (value.error !== undefined) {
        message.error = value.error;
    }
    if (errorEnvelope !== undefined && errorEnvelope !== null) {
        message.errorEnvelope = errorEnvelope;
    }
    return message;
}

function decodeAssistantAccount(value: unknown): IAgentAssistantAccount | null {
    if (
        !isRecord(value)
        || (value.type !== 'chatgpt' && value.type !== 'apiKey' && value.type !== 'other')
        || (value.email !== undefined && typeof value.email !== 'string')
        || (value.planType !== undefined && typeof value.planType !== 'string')
    ) {
        return null;
    }
    return {
        type: value.type,
        ...(value.email === undefined ? {} : {email: value.email}),
        ...(value.planType === undefined ? {} : {planType: value.planType}),
    };
}

function decodeAssistantEffortOption(value: unknown): IAgentAssistantEffortOption | null {
    if (
        !isRecord(value)
        || typeof value.id !== 'string'
        || typeof value.label !== 'string'
        || (value.description !== undefined && typeof value.description !== 'string')
        || (value.isDefault !== undefined && typeof value.isDefault !== 'boolean')
    ) {
        return null;
    }
    return {
        id: value.id,
        label: value.label,
        ...(value.description === undefined ? {} : {description: value.description}),
        ...(value.isDefault === undefined ? {} : {isDefault: value.isDefault}),
    };
}

function decodeAssistantServiceTierOption(value: unknown): IAgentAssistantServiceTierOption | null {
    if (
        !isRecord(value)
        || typeof value.id !== 'string'
        || typeof value.label !== 'string'
        || (value.description !== undefined && typeof value.description !== 'string')
        || (value.isDefault !== undefined && typeof value.isDefault !== 'boolean')
    ) {
        return null;
    }
    return {
        id: value.id,
        label: value.label,
        ...(value.description === undefined ? {} : {description: value.description}),
        ...(value.isDefault === undefined ? {} : {isDefault: value.isDefault}),
    };
}

function decodeAssistantModelOption(value: unknown): IAgentAssistantModelOption | null {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.label !== 'string') {
        return null;
    }
    const reasoningEfforts = value.reasoningEfforts === undefined
        ? undefined
        : decodeArray(value.reasoningEfforts, decodeAssistantEffortOption);
    const serviceTiers = value.serviceTiers === undefined
        ? undefined
        : decodeArray(value.serviceTiers, decodeAssistantServiceTierOption);
    if (
        reasoningEfforts === null
        || serviceTiers === null
        || (
            value.defaultReasoningEffort !== undefined
            && value.defaultReasoningEffort !== null
            && typeof value.defaultReasoningEffort !== 'string'
        )
        || (
            value.defaultServiceTier !== undefined
            && value.defaultServiceTier !== null
            && typeof value.defaultServiceTier !== 'string'
        )
    ) {
        return null;
    }
    return {
        id: value.id,
        label: value.label,
        ...(reasoningEfforts === undefined ? {} : {reasoningEfforts}),
        ...(value.defaultReasoningEffort === undefined
            ? {}
            : {defaultReasoningEffort: value.defaultReasoningEffort}),
        ...(serviceTiers === undefined ? {} : {serviceTiers}),
        ...(value.defaultServiceTier === undefined
            ? {}
            : {defaultServiceTier: value.defaultServiceTier}),
    };
}

function decodeAssistantMcpStatus(value: unknown): IAgentAssistantMcpStatus | null {
    if (
        !isRecord(value)
        || typeof value.serverName !== 'string'
        || typeof value.serverUrl !== 'string'
        || typeof value.serverRunning !== 'boolean'
        || typeof value.toolCount !== 'number'
        || !Number.isSafeInteger(value.toolCount)
        || value.toolCount < 0
    ) {
        return null;
    }
    return {
        serverName: value.serverName,
        serverUrl: value.serverUrl,
        serverRunning: value.serverRunning,
        toolCount: value.toolCount,
    };
}

function decodeAssistantTurnState(value: unknown): IAgentAssistantTurnState | null {
    const usage = value && isRecord(value) && value.usage !== null
        ? decodeAssistantTokenUsage(value.usage)
        : null;
    if (
        !isRecord(value)
        || (value.id !== null && typeof value.id !== 'string')
        || !isOneOf(AGENT_ASSISTANT_TURN_PHASES, value.phase)
        || typeof value.reasoning !== 'string'
        || !Array.isArray(value.toolActivity)
        || !value.toolActivity.every(isAssistantToolActivity)
        || (value.lastEventAtMs !== null && (typeof value.lastEventAtMs !== 'number' || !Number.isFinite(value.lastEventAtMs)))
        || usage === null && value.usage !== null
    ) {
        return null;
    }
    return {
        id: value.id,
        phase: value.phase,
        reasoning: value.reasoning,
        toolActivity: value.toolActivity,
        lastEventAtMs: value.lastEventAtMs,
        usage,
    };
}

function decodeAssistantTokenUsage(value: unknown): IAgentAssistantTurnState['usage'] {
    if (!isRecord(value)
        || typeof value.inputTokens !== 'number'
        || typeof value.outputTokens !== 'number'
        || (value.cachedInputTokens !== undefined && typeof value.cachedInputTokens !== 'number')) {
        return null;
    }
    return {
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        ...(value.cachedInputTokens === undefined ? {} : {cachedInputTokens: value.cachedInputTokens}),
    };
}

function isAssistantToolActivity(value: unknown): value is IAgentAssistantTurnState['toolActivity'][number] {
    return isRecord(value)
        && typeof value.toolId === 'string'
        && typeof value.name === 'string'
        && (value.phase === 'running' || value.phase === 'completed' || value.phase === 'failed')
        && typeof value.startedAtMs === 'number'
        && Number.isFinite(value.startedAtMs)
        && (value.completedAtMs === undefined
            || typeof value.completedAtMs === 'number' && Number.isFinite(value.completedAtMs));
}

function decodeDocumentRevisionInfo(value: unknown) {
    if (!isDocumentRevisionInfo(value)) {
        return null;
    }
    const token = parseDocumentRevisionToken(value.token);
    if (token === null) {
        return null;
    }
    return {
        version: 1 as const,
        token,
        documentRef: value.documentRef,
        authority: value.authority,
        contentRevision: value.contentRevision,
        mintedAt: value.mintedAt,
    };
}

export function decodeAgentAssistantChatScope(value: unknown): IAgentAssistantChatScope | null {
    if (
        !isRecord(value)
        || value.kind !== 'document'
        || typeof value.key !== 'string'
        || value.key.trim().length === 0
        || (value.title !== null && typeof value.title !== 'string')
        || (value.tabId !== undefined && value.tabId !== null && typeof value.tabId !== 'string')
        || (
            value.documentSessionKey !== undefined
            && value.documentSessionKey !== null
            && typeof value.documentSessionKey !== 'string'
        )
        || (value.documentRef !== undefined && value.documentRef !== null && typeof value.documentRef !== 'string')
        || (
            value.documentBackend !== undefined
            && value.documentBackend !== 'browser'
            && value.documentBackend !== 'electron'
        )
    ) {
        return null;
    }
    const documentInstanceId = value.documentInstanceId === undefined || value.documentInstanceId === null
        ? value.documentInstanceId
        : parseDocumentInstanceId(value.documentInstanceId);
    const documentIdentity = value.documentIdentity === undefined || value.documentIdentity === null
        ? value.documentIdentity
        : decodeDocumentRevisionInfo(value.documentIdentity);
    const commandTarget = decodeWorkspaceCommandTarget(value.commandTarget);
    if (
        documentInstanceId === null && value.documentInstanceId !== null
        || documentIdentity === null && value.documentIdentity !== null
        || commandTarget === null
        || value.commandTarget === null
    ) {
        return null;
    }
    return {
        kind: 'document',
        key: value.key,
        title: value.title,
        ...(value.tabId === undefined ? {} : {tabId: value.tabId}),
        ...(value.documentSessionKey === undefined ? {} : {documentSessionKey: value.documentSessionKey}),
        ...(documentInstanceId === undefined ? {} : {documentInstanceId}),
        ...(value.documentRef === undefined ? {} : {documentRef: value.documentRef}),
        ...(value.documentBackend === undefined ? {} : {documentBackend: value.documentBackend}),
        ...(documentIdentity === undefined ? {} : {documentIdentity}),
        ...(commandTarget === undefined ? {} : {commandTarget}),
    };
}

function decodeAssistantProviderStatus(value: unknown): IAgentAssistantProviderStatus | null {
    if (!isRecord(value)) {
        return null;
    }
    const models = decodeArray(value.models, decodeAssistantModelOption);
    const availableEfforts = decodeStringArray(value.availableEfforts);
    const availableSpeedModes = Array.isArray(value.availableSpeedModes)
        && value.availableSpeedModes.every(mode => isOneOf(AGENT_ASSISTANT_SPEED_MODES, mode))
        ? [...value.availableSpeedModes]
        : null;
    const account = value.account === null ? null : decodeAssistantAccount(value.account);
    const errorEnvelope = value.errorEnvelope === undefined
        ? undefined
        : decodeAssistantErrorEnvelope(value.errorEnvelope);
    if (
        !isOneOf(ASSISTANT_PROVIDER_IDS, value.id)
        || typeof value.label !== 'string'
        || !isOneOf(AGENT_ASSISTANT_INSTALL_STATES, value.installState)
        || !isOneOf(AGENT_ASSISTANT_AUTH_STATES, value.authState)
        || !isOneOf(AGENT_ASSISTANT_RUNTIME_STATES, value.runtimeState)
        || models === null
        || typeof value.defaultModel !== 'string'
        || typeof value.activeModel !== 'string'
        || !isOneOf(AGENT_ASSISTANT_MODEL_SWITCH_MODES, value.modelSwitchMode)
        || availableEfforts === null
        || typeof value.defaultEffort !== 'string'
        || typeof value.activeEffort !== 'string'
        || availableSpeedModes === null
        || !isOneOf(AGENT_ASSISTANT_SPEED_MODES, value.defaultSpeedMode)
        || !isOneOf(AGENT_ASSISTANT_SPEED_MODES, value.activeSpeedMode)
        || (value.path !== null && typeof value.path !== 'string')
        || (value.version !== null && typeof value.version !== 'string')
        || (value.minimumVersion !== null && typeof value.minimumVersion !== 'string')
        || typeof value.versionSupported !== 'boolean'
        || typeof value.installUrl !== 'string'
        || account === null && value.account !== null
        || (value.error !== undefined && typeof value.error !== 'string')
        || errorEnvelope === null
    ) {
        return null;
    }
    return {
        id: value.id,
        label: value.label,
        installState: value.installState,
        authState: value.authState,
        runtimeState: value.runtimeState,
        models,
        defaultModel: value.defaultModel,
        activeModel: value.activeModel,
        modelSwitchMode: value.modelSwitchMode,
        availableEfforts,
        defaultEffort: value.defaultEffort,
        activeEffort: value.activeEffort,
        availableSpeedModes,
        defaultSpeedMode: value.defaultSpeedMode,
        activeSpeedMode: value.activeSpeedMode,
        path: value.path,
        version: value.version,
        minimumVersion: value.minimumVersion,
        versionSupported: value.versionSupported,
        installUrl: value.installUrl,
        account,
        ...(value.error === undefined ? {} : {error: value.error}),
        ...(errorEnvelope === undefined ? {} : {errorEnvelope}),
    };
}

function decodeAgentAssistantStatus(value: unknown): IAgentAssistantStatus | null {
    if (!isRecord(value)) {
        return null;
    }
    const providers = decodeArray(value.providers, decodeAssistantProviderStatus);
    const models = decodeArray(value.models, decodeAssistantModelOption);
    const availableEfforts = decodeStringArray(value.availableEfforts);
    const availableSpeedModes = Array.isArray(value.availableSpeedModes)
        && value.availableSpeedModes.every(mode => isOneOf(AGENT_ASSISTANT_SPEED_MODES, mode))
        ? [...value.availableSpeedModes]
        : null;
    const account = value.account === null ? null : decodeAssistantAccount(value.account);
    const mcp = decodeAssistantMcpStatus(value.mcp);
    const turn = decodeAssistantTurnState(value.turn);
    const errorEnvelope = value.errorEnvelope === undefined
        ? undefined
        : decodeAssistantErrorEnvelope(value.errorEnvelope);
    if (
        typeof value.supported !== 'boolean'
        || typeof value.platform !== 'string'
        || !isOneOf(ASSISTANT_PROVIDER_IDS, value.provider)
        || typeof value.providerLabel !== 'string'
        || providers === null
        || typeof value.model !== 'string'
        || typeof value.modelLabel !== 'string'
        || models === null
        || !isOneOf(AGENT_ASSISTANT_MODEL_SWITCH_MODES, value.modelSwitchMode)
        || typeof value.effort !== 'string'
        || availableEfforts === null
        || !isOneOf(AGENT_ASSISTANT_SPEED_MODES, value.speedMode)
        || availableSpeedModes === null
        || !isOneOf(AGENT_ASSISTANT_INSTALL_STATES, value.installState)
        || typeof value.codexInstalled !== 'boolean'
        || (value.codexPath !== null && typeof value.codexPath !== 'string')
        || (value.codexVersion !== null && typeof value.codexVersion !== 'string')
        || typeof value.minimumCodexVersion !== 'string'
        || typeof value.codexVersionSupported !== 'boolean'
        || typeof value.installUrl !== 'string'
        || typeof value.installScriptUrl !== 'string'
        || typeof value.managedInstallDir !== 'string'
        || !isOneOf(AGENT_ASSISTANT_AUTH_STATES, value.authState)
        || account === null && value.account !== null
        || !isOneOf(AGENT_ASSISTANT_RUNTIME_STATES, value.runtimeState)
        || mcp === null
        || turn === null
        || typeof value.lastCheckedAt !== 'string'
        || (value.error !== undefined && typeof value.error !== 'string')
        || errorEnvelope === null
    ) {
        return null;
    }
    return {
        supported: value.supported,
        platform: value.platform,
        provider: value.provider,
        providerLabel: value.providerLabel,
        providers,
        model: value.model,
        modelLabel: value.modelLabel,
        models,
        modelSwitchMode: value.modelSwitchMode,
        effort: value.effort,
        availableEfforts,
        speedMode: value.speedMode,
        availableSpeedModes,
        installState: value.installState,
        codexInstalled: value.codexInstalled,
        codexPath: value.codexPath,
        codexVersion: value.codexVersion,
        minimumCodexVersion: value.minimumCodexVersion,
        codexVersionSupported: value.codexVersionSupported,
        installUrl: value.installUrl,
        installScriptUrl: value.installScriptUrl,
        managedInstallDir: value.managedInstallDir,
        authState: value.authState,
        account,
        runtimeState: value.runtimeState,
        mcp,
        turn,
        lastCheckedAt: value.lastCheckedAt,
        ...(value.error === undefined ? {} : {error: value.error}),
        ...(errorEnvelope === undefined ? {} : {errorEnvelope}),
    };
}

export function decodeAgentAssistantState(value: unknown): IAgentAssistantState | null {
    if (!isRecord(value)) {
        return null;
    }
    const scope = value.scope === null ? null : decodeAgentAssistantChatScope(value.scope);
    const status = decodeAgentAssistantStatus(value.status);
    const messages = decodeArray(value.messages, decodeAssistantMessage);
    if (scope === null && value.scope !== null || status === null || messages === null) {
        return null;
    }
    return {
        scope,
        status,
        messages,
    };
}

function decodeAssistantOperationResult(
    value: unknown,
): Pick<IAgentAssistantInstallResult, 'ok' | 'state' | 'error' | 'errorEnvelope'> | null {
    if (!isRecord(value) || typeof value.ok !== 'boolean') {
        return null;
    }
    const state = decodeAgentAssistantState(value.state);
    const errorEnvelope = value.errorEnvelope === undefined
        ? undefined
        : decodeAssistantErrorEnvelope(value.errorEnvelope);
    if (
        state === null
        || (value.error !== undefined && typeof value.error !== 'string')
        || errorEnvelope === null
    ) {
        return null;
    }
    return {
        ok: value.ok,
        state,
        ...(value.error === undefined ? {} : {error: value.error}),
        ...(errorEnvelope === undefined ? {} : {errorEnvelope}),
    };
}

export function decodeAgentAssistantInstallResult(value: unknown): IAgentAssistantInstallResult | null {
    return decodeAssistantOperationResult(value);
}

export function decodeAgentAssistantSendMessageResult(value: unknown): IAgentAssistantSendMessageResult | null {
    return decodeAssistantOperationResult(value);
}

export function decodeAgentAssistantLoginResult(value: unknown): IAgentAssistantLoginResult | null {
    const result = decodeAssistantOperationResult(value);
    if (
        result === null
        || !isRecord(value)
        || (value.loginId !== undefined && typeof value.loginId !== 'string')
        || (value.authUrl !== undefined && typeof value.authUrl !== 'string')
        || (value.verificationUrl !== undefined && typeof value.verificationUrl !== 'string')
        || (value.userCode !== undefined && typeof value.userCode !== 'string')
    ) {
        return null;
    }
    return {
        ...result,
        ...(value.loginId === undefined ? {} : {loginId: value.loginId}),
        ...(value.authUrl === undefined ? {} : {authUrl: value.authUrl}),
        ...(value.verificationUrl === undefined ? {} : {verificationUrl: value.verificationUrl}),
        ...(value.userCode === undefined ? {} : {userCode: value.userCode}),
    };
}

export function decodeAgentWorkspaceSnapshotRequest(value: unknown): IAgentEventMap['agent:workspaceSnapshotRequest'] | null {
    if (!isRecord(value)) {
        return null;
    }

    const requestId = normalizeNonEmptyString(value.requestId);
    const windowId = normalizeOptionalWindowId(value.windowId);
    const lastSeenRevision = normalizeOptionalRevision(value.lastSeenRevision);
    const scope = decodeCommandExecutionScope(value.scope);
    if (requestId === null || windowId === null || lastSeenRevision === null || scope === null) {
        return null;
    }

    return {
        requestId,
        ...(windowId === undefined ? {} : {windowId}),
        ...(lastSeenRevision === undefined ? {} : {lastSeenRevision}),
        ...(scope === undefined ? {} : {scope}),
    };
}

export function decodeAgentCommandRequest(value: unknown): IAgentEventMap['agent:commandRequest'] | null {
    if (!isRecord(value)) {
        return null;
    }

    const requestId = normalizeNonEmptyString(value.requestId);
    const windowId = normalizeOptionalWindowId(value.windowId);
    const scope = decodeCommandExecutionScope(value.scope);
    const command = decodeAgentCommand(value.command);
    if (requestId === null || windowId === null || scope === null || command === null) {
        return null;
    }

    return {
        requestId,
        ...(windowId === undefined ? {} : {windowId}),
        ...(scope === undefined ? {} : {scope}),
        command,
    };
}

export function decodeAgentCommandCancelRequest(
    value: unknown,
): IAgentEventMap['agent:commandCancelRequest'] | null {
    if (!isRecord(value)) {
        return null;
    }

    const requestId = normalizeNonEmptyString(value.requestId);
    const windowId = normalizeOptionalWindowId(value.windowId);
    if (requestId === null || windowId === null) {
        return null;
    }

    return {
        requestId,
        ...(windowId === undefined ? {} : {windowId}),
    };
}

export function decodeAgentAssistantEvent(value: unknown): IAgentEventMap['agent:assistantEvent'] | null {
    if (!isRecord(value) || !isAssistantEventType(value.type)) {
        return null;
    }

    const event: IAgentEventMap['agent:assistantEvent'] = {type: value.type};
    if (value.state !== undefined) {
        const state = decodeAgentAssistantState(value.state);
        if (state === null) {
            return null;
        }
        event.state = state;
    }
    if (value.message !== undefined) {
        const message = decodeAssistantMessage(value.message);
        if (message === null) {
            return null;
        }
        event.message = message;
    }
    if (value.messageId !== undefined) {
        const messageId = normalizeNonEmptyString(value.messageId);
        if (messageId === null) {
            return null;
        }
        event.messageId = messageId;
    }
    if (value.delta !== undefined) {
        if (typeof value.delta !== 'string') {
            return null;
        }
        event.delta = value.delta;
    }
    if (value.reasoningDelta !== undefined) {
        if (typeof value.reasoningDelta !== 'string') {
            return null;
        }
        event.reasoningDelta = value.reasoningDelta;
    }
    if (value.binding !== undefined) {
        if (
            !isRecord(value.binding)
            || typeof value.binding.scopeFingerprint !== 'string'
            || typeof value.binding.sessionKey !== 'string'
            || !Number.isInteger(value.binding.turnGeneration)
            || (value.binding.turnGeneration as number) < 0
            || !Number.isInteger(value.binding.windowId)
            || (value.binding.windowId as number) < 0
        ) {
            return null;
        }
        event.binding = {
            scopeFingerprint: value.binding.scopeFingerprint,
            sessionKey: value.binding.sessionKey,
            turnGeneration: value.binding.turnGeneration as number,
            windowId: value.binding.windowId as number,
        };
    }
    if (value.turnId !== undefined) {
        const turnId = normalizeNonEmptyString(value.turnId);
        if (turnId === null) {
            return null;
        }
        event.turnId = turnId;
    }
    if (value.phase !== undefined) {
        if (!isOneOf(AGENT_ASSISTANT_TURN_PHASES, value.phase)) {
            return null;
        }
        event.phase = value.phase;
    }
    if (value.toolActivity !== undefined) {
        if (!isAssistantToolActivity(value.toolActivity)) {
            return null;
        }
        event.toolActivity = value.toolActivity;
    }
    if (value.lastEventAtMs !== undefined) {
        if (typeof value.lastEventAtMs !== 'number' || !Number.isFinite(value.lastEventAtMs)) {
            return null;
        }
        event.lastEventAtMs = value.lastEventAtMs;
    }
    if (value.progress !== undefined) {
        if (typeof value.progress !== 'string') {
            return null;
        }
        event.progress = value.progress;
    }
    if (value.error !== undefined) {
        if (typeof value.error !== 'string') {
            return null;
        }
        event.error = value.error;
    }
    if (value.errorEnvelope !== undefined) {
        const errorEnvelope = decodeAssistantErrorEnvelope(value.errorEnvelope);
        if (errorEnvelope === null) {
            return null;
        }
        event.errorEnvelope = errorEnvelope;
    }

    if (event.binding === undefined && event.state === undefined) {
        return null;
    }

    return event;
}
