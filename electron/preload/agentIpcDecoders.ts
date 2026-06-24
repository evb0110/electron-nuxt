import type {
    IAgentAssistantChatMessage,
    IAgentAssistantErrorEnvelope,
    IAgentAssistantEvent,
    IAgentAssistantImageAttachment,
    IAgentAssistantState,
    IAgentCommandRequest,
    IAgentWorkspaceSnapshotRequest,
    TAgentAssistantErrorCode,
    TAgentAssistantEventType,
    TAgentAssistantMessageRole,
    TAgentCommand,
} from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';

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
    return typeof value === 'string'
        && AGENT_ASSISTANT_EVENT_TYPES.includes(value as TAgentAssistantEventType);
}

function isAssistantMessageRole(value: unknown): value is TAgentAssistantMessageRole {
    return typeof value === 'string'
        && AGENT_ASSISTANT_MESSAGE_ROLES.includes(value as TAgentAssistantMessageRole);
}

function isAssistantErrorCode(value: unknown): value is TAgentAssistantErrorCode {
    return typeof value === 'string'
        && AGENT_ASSISTANT_ERROR_CODES.includes(value as TAgentAssistantErrorCode);
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

export function decodeAgentWorkspaceSnapshotRequest(value: unknown): IAgentWorkspaceSnapshotRequest | null {
    if (!isRecord(value)) {
        return null;
    }

    const requestId = normalizeNonEmptyString(value.requestId);
    const windowId = normalizeOptionalWindowId(value.windowId);
    const lastSeenRevision = normalizeOptionalRevision(value.lastSeenRevision);
    if (requestId === null || windowId === null || lastSeenRevision === null) {
        return null;
    }

    return {
        requestId,
        ...(windowId === undefined ? {} : {windowId}),
        ...(lastSeenRevision === undefined ? {} : {lastSeenRevision}),
    };
}

export function decodeAgentCommandRequest(value: unknown): IAgentCommandRequest | null {
    if (!isRecord(value)) {
        return null;
    }

    const requestId = normalizeNonEmptyString(value.requestId);
    const windowId = normalizeOptionalWindowId(value.windowId);
    const command = decodeAgentCommand(value.command);
    if (requestId === null || windowId === null || command === null) {
        return null;
    }

    return {
        requestId,
        ...(windowId === undefined ? {} : {windowId}),
        command,
    };
}

export function decodeAgentAssistantEvent(value: unknown): IAgentAssistantEvent | null {
    if (!isRecord(value) || !isAssistantEventType(value.type)) {
        return null;
    }

    const event: IAgentAssistantEvent = {type: value.type};
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
