import type {
    IAgentAssistantChatMessage,
    IAgentAssistantErrorEnvelope,
    IAgentAssistantImageAttachment,
    IAgentCommandExecutionScope,
    IAgentAssistantState,
    TAgentAssistantErrorCode,
    TAgentAssistantEventType,
    TAgentAssistantMessageRole,
    TAgentCommand,
    TAgentWorkspaceCommandTarget,
} from '@contracts/agent';
import type { TDocumentBackend } from '@contracts/documentRef';
import { isDocumentRevisionInfo } from '@contracts/documentRevision';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import type { IAgentEventMap } from '@electron/features/agent/contract';

const AGENT_ASSISTANT_EVENT_TYPES = [
    'state',
    'message',
    'message-delta',
    'turn-started',
    'turn-completed',
    'install-progress',
    'error',
] as const satisfies readonly TAgentAssistantEventType[];

const AGENT_ASSISTANT_MESSAGE_ROLES = [
    'user',
    'assistant',
    'system',
] as const satisfies readonly TAgentAssistantMessageRole[];

const AGENT_ASSISTANT_ERROR_CODES = [
    'AUTH_REQUIRED',
    'INSTALL_MISSING',
    'LOGIN_CANCELLED',
    'USER_INTERRUPTED',
    'MODEL_UNAVAILABLE',
    'RUNTIME_UNAVAILABLE',
    'PROVIDER_RATE_LIMITED',
    'INTERNAL',
] as const satisfies readonly TAgentAssistantErrorCode[];

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

    return normalizeNonEmptyString(value);
}

function normalizeOptionalDocumentInstanceId(value: unknown) {
    if (value === undefined || value === null) {
        return null;
    }

    return normalizeNonEmptyString(value);
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

function isAssistantEventType(value: unknown): value is TAgentAssistantEventType {
    return isOneOf(AGENT_ASSISTANT_EVENT_TYPES, value);
}

function isAssistantMessageRole(value: unknown): value is TAgentAssistantMessageRole {
    return isOneOf(AGENT_ASSISTANT_MESSAGE_ROLES, value);
}

function isAssistantErrorCode(value: unknown): value is TAgentAssistantErrorCode {
    return isOneOf(AGENT_ASSISTANT_ERROR_CODES, value);
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

function decodeAssistantImageAttachment(value: unknown): IAgentAssistantImageAttachment | null {
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
            const decoded = decodeAssistantImageAttachment(attachment);
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

function isAssistantStatus(value: unknown): value is IAgentAssistantState['status'] {
    return isRecord(value)
        && typeof value.provider === 'string'
        && typeof value.model === 'string'
        && typeof value.runtimeState === 'string'
        && Array.isArray(value.providers)
        && isRecord(value.turn);
}

function decodeAssistantState(value: unknown): IAgentAssistantState | null {
    if (
        !isRecord(value)
        || (value.scope !== null && value.scope !== undefined && !isRecord(value.scope))
        || !isAssistantStatus(value.status)
        || !Array.isArray(value.messages)
    ) {
        return null;
    }

    const messages: IAgentAssistantChatMessage[] = [];
    for (const message of value.messages) {
        const decoded = decodeAssistantMessage(message);
        if (decoded === null) {
            return null;
        }
        messages.push(decoded);
    }

    return {
        scope: (value.scope ?? null) as IAgentAssistantState['scope'],
        status: value.status,
        messages,
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
        const state = decodeAssistantState(value.state);
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
    if (value.turnId !== undefined) {
        const turnId = normalizeNonEmptyString(value.turnId);
        if (turnId === null) {
            return null;
        }
        event.turnId = turnId;
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

    return event;
}
