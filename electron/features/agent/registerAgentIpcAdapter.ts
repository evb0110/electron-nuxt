import type { IpcMainInvokeEvent } from 'electron';
import {
    BrowserWindow,
    ipcMain,
} from 'electron';
import type { IIpcMainRegistrar as IContractIpcMainRegistrar } from '@contracts/ipcMain';
import { isRecord } from '@contracts/runtimeGuards';
import type {
    IAgentAssistantChatScope,
    IAgentAssistantImageAttachment,
    IAgentAssistantLoginRequest,
    IAgentAssistantSendMessageRequest,
    IAgentAssistantStateRequest,
    TAgentAssistantProviderId,
    TAgentWorkspaceCommandTarget,
} from '@contracts/agent';
import {
    AGENT_CHANNELS,
    type IAgentInvokeMap,
} from '@electron/features/agent/contract';
import { isDocumentRevisionInfo } from '@contracts/documentRevision';
import { createAgentService } from '@electron/features/agent/createAgentService';
import {
    ASSISTANT_MAX_IMAGE_ATTACHMENTS,
    ASSISTANT_MAX_IMAGE_BYTES,
} from '@electron/features/agent/codexAssistantConfig';
import type {
    IAgentIpcContext,
    IAgentService,
} from '@electron/features/agent/ports';

export type TAgentIpcMainRegistrar = IContractIpcMainRegistrar<IAgentInvokeMap, IpcMainInvokeEvent>;

const ASSISTANT_MAX_IMAGE_DATA_URL_LENGTH = Math.ceil(ASSISTANT_MAX_IMAGE_BYTES / 3) * 4 + 128;
const ASSISTANT_IMAGE_DATA_URL_PREFIX_RE = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[a-z0-9.+/-]+)*;base64,/iu;

function createAgentIpcContext(event: IpcMainInvokeEvent): IAgentIpcContext {
    return {
        event,
        sender: event.sender,
        senderId: event.sender.id,
        parentWindow: BrowserWindow.fromWebContents(event.sender),
    };
}

function isAgentAssistantLoginRequest(request: unknown): request is IAgentAssistantLoginRequest {
    return isRecord(request) && (request.mode === 'chatgpt' || request.mode === 'device-code');
}

function isAgentAssistantProviderId(provider: unknown): provider is TAgentAssistantProviderId {
    return provider === 'codex' || provider === 'claude';
}

function isAgentAssistantSpeedMode(speedMode: unknown) {
    return speedMode === 'fast' || speedMode === 'standard';
}

function isAgentWorkspaceCommandTarget(target: unknown): target is TAgentWorkspaceCommandTarget {
    if (!isRecord(target)) {
        return false;
    }

    if (
        typeof target.tabId !== 'string'
        || target.tabId.trim().length === 0
        || typeof target.sessionId !== 'string'
        || target.sessionId.trim().length === 0
        || (target.documentRef !== null && typeof target.documentRef !== 'string')
        || (target.documentBackend !== undefined && target.documentBackend !== 'browser' && target.documentBackend !== 'electron')
        || (target.documentRevisionToken !== undefined && typeof target.documentRevisionToken !== 'string')
    ) {
        return false;
    }

    if (target.kind === 'transaction') {
        return typeof target.transactionId === 'string' && target.transactionId.trim().length > 0;
    }

    return target.kind === 'revision'
        && typeof target.sessionRevision === 'number'
        && Number.isInteger(target.sessionRevision)
        && target.sessionRevision >= 0;
}

function isOptionalAssistantSelection(request: Record<PropertyKey, unknown>) {
    return (
        (request.provider === undefined || isAgentAssistantProviderId(request.provider))
        && (request.model === undefined || typeof request.model === 'string')
        && (request.effort === undefined || typeof request.effort === 'string')
        && (request.speedMode === undefined || isAgentAssistantSpeedMode(request.speedMode))
    );
}

function isAgentAssistantChatScope(scope: unknown): scope is IAgentAssistantChatScope {
    return isRecord(scope)
        && scope.kind === 'document'
        && typeof scope.key === 'string'
        && scope.key.trim().length > 0
        && (scope.title === null || typeof scope.title === 'string')
        && (scope.tabId === undefined || scope.tabId === null || typeof scope.tabId === 'string')
        && (scope.documentRef === undefined || scope.documentRef === null || typeof scope.documentRef === 'string')
        && (
            scope.documentBackend === undefined
            || scope.documentBackend === 'browser'
            || scope.documentBackend === 'electron'
        )
        && (
            scope.documentIdentity === undefined
            || scope.documentIdentity === null
            || isDocumentRevisionInfo(scope.documentIdentity)
        )
        && (
            scope.commandTarget === undefined
            || isAgentWorkspaceCommandTarget(scope.commandTarget)
        );
}

function isAgentAssistantStateRequest(request: unknown): request is IAgentAssistantStateRequest {
    return request === undefined
        || request === null
        || (
            isRecord(request)
            && isOptionalAssistantSelection(request)
            && (
                request.scope === undefined
                || request.scope === null
                || isAgentAssistantChatScope(request.scope)
            )
        );
}

function isAgentAssistantImageAttachment(attachment: unknown): attachment is IAgentAssistantImageAttachment {
    return isRecord(attachment)
        && attachment.type === 'image'
        && typeof attachment.id === 'string'
        && typeof attachment.name === 'string'
        && typeof attachment.mimeType === 'string'
        && attachment.mimeType.toLowerCase().startsWith('image/')
        && typeof attachment.sizeBytes === 'number'
        && Number.isFinite(attachment.sizeBytes)
        && attachment.sizeBytes > 0
        && attachment.sizeBytes <= ASSISTANT_MAX_IMAGE_BYTES
        && typeof attachment.dataUrl === 'string'
        && attachment.dataUrl.length <= ASSISTANT_MAX_IMAGE_DATA_URL_LENGTH
        && ASSISTANT_IMAGE_DATA_URL_PREFIX_RE.test(attachment.dataUrl);
}

function isAgentAssistantImageAttachmentList(attachments: unknown): attachments is IAgentAssistantImageAttachment[] {
    return Array.isArray(attachments)
        && attachments.length <= ASSISTANT_MAX_IMAGE_ATTACHMENTS
        && attachments.every(isAgentAssistantImageAttachment);
}

function isAgentAssistantSendMessageRequest(request: unknown): request is IAgentAssistantSendMessageRequest {
    return isRecord(request)
        && typeof request.text === 'string'
        && isOptionalAssistantSelection(request)
        && (
            request.scope === undefined
            || request.scope === null
            || isAgentAssistantChatScope(request.scope)
        )
        && (
            request.attachments === undefined
            || isAgentAssistantImageAttachmentList(request.attachments)
        )
        && (
            request.presetId === undefined
            || typeof request.presetId === 'string'
        );
}

export function registerAgentIpcAdapter(
    registrar: TAgentIpcMainRegistrar = ipcMain,
    service: IAgentService = createAgentService(),
) {
    registrar.handle(AGENT_CHANNELS.getMcpIntegrationStatus, event =>
        service.getMcpIntegrationStatus(createAgentIpcContext(event)),
    );

    registrar.handle(AGENT_CHANNELS.setMcpIntegrationEnabled, (event, enabled: unknown) => {
        if (typeof enabled !== 'boolean') {
            throw new Error('Invalid agent MCP enabled payload');
        }
        return service.setMcpIntegrationEnabled(createAgentIpcContext(event), enabled);
    });

    registrar.handle(AGENT_CHANNELS.getAssistantState, (event, request: unknown) => {
        if (!isAgentAssistantStateRequest(request)) {
            throw new Error('Invalid assistant state request payload');
        }
        return service.getAssistantState(createAgentIpcContext(event), request);
    });

    registrar.handle(AGENT_CHANNELS.installAssistantCodex, event =>
        service.installAssistantCodex(createAgentIpcContext(event)),
    );

    registrar.handle(AGENT_CHANNELS.startAssistantLogin, (event, request: unknown) => {
        if (!isAgentAssistantLoginRequest(request)) {
            throw new Error('Invalid assistant login request payload');
        }
        return service.startAssistantLogin(createAgentIpcContext(event), request);
    });

    registrar.handle(AGENT_CHANNELS.cancelAssistantLogin, event =>
        service.cancelAssistantLogin(createAgentIpcContext(event)),
    );

    registrar.handle(AGENT_CHANNELS.sendAssistantMessage, (event, request: unknown) => {
        if (!isAgentAssistantSendMessageRequest(request)) {
            throw new Error('Invalid assistant message payload');
        }
        return service.sendAssistantMessage(createAgentIpcContext(event), request);
    });

    registrar.handle(AGENT_CHANNELS.interruptAssistant, (event, request: unknown) => {
        if (!isAgentAssistantStateRequest(request)) {
            throw new Error('Invalid assistant interrupt request payload');
        }
        return service.interruptAssistant(createAgentIpcContext(event), request);
    });

    registrar.handle(AGENT_CHANNELS.resetAssistantChat, (event, request: unknown) => {
        if (!isAgentAssistantStateRequest(request)) {
            throw new Error('Invalid assistant reset request payload');
        }
        return service.resetAssistantChat(createAgentIpcContext(event), request);
    });

    registrar.handle(AGENT_CHANNELS.submitWorkspaceSnapshot, (event, response: unknown) =>
        service.submitWorkspaceSnapshot(createAgentIpcContext(event), response),
    );

    registrar.handle(AGENT_CHANNELS.submitCommandResponse, (event, response: unknown) =>
        service.submitCommandResponse(createAgentIpcContext(event), response),
    );
}
