import type { TEditorLayoutNode } from '@contracts/editorPanes';
import type {
    TDocumentBackend,
    TDocumentRef,
} from '@contracts/documentRef';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type { TDocumentInstanceId } from '@contracts/documentInstanceId';

export type TAgentDocumentKind = 'empty' | 'pdf' | 'djvu' | 'image' | 'unknown';
export type TAgentDocumentReadinessStatus = 'ready' | 'needs-preparation' | 'unknown' | 'empty';
export type TAgentOcrCoverageStatus = 'complete' | 'partial' | 'none' | 'unknown';
export type TAgentRecommendationId = 'convert_to_pdf' | 'ocr_all_pages';
export const AGENT_CAPABILITY_DOMAINS = [
    'workspace',
    'document',
    'annotation',
    'toc',
    'page_labels',
    'bookmarks',
    'ocr',
    'ui',
    'view',
    'file',
    'export',
    'page_ops',
    'history',
] as const;
export const AGENT_CAPABILITY_RISKS = [
    'read',
    'navigate',
    'write',
    'destructive',
    'longRunning',
] as const;
export type TAgentCapabilityDomain = typeof AGENT_CAPABILITY_DOMAINS[number];
export type TAgentCapabilityRisk = typeof AGENT_CAPABILITY_RISKS[number];
export type TAgentCommandName = 'activate_tab' | 'go_to_page' | 'run_action' | 'read_resource';
export type TAgentMcpCodexRegistrationState = 'configured' | 'missing' | 'mismatched' | 'unknown';
export type TAgentAssistantInstallState = 'installed' | 'missing' | 'unsupported';
export type TAgentAssistantAuthState = 'signed-in' | 'signed-out' | 'login-pending' | 'unknown';
export type TAgentAssistantRuntimeState = 'stopped' | 'starting' | 'ready' | 'busy' | 'error';
export const AGENT_ASSISTANT_TURN_PHASES = [
    'idle',
    'queued',
    'thinking',
    'streaming',
    'tool-running',
    'finalizing',
    'done',
    'failed',
    'cancelled',
    'stalled',
    'interrupting',
] as const;
export type TAgentAssistantTurnPhase = typeof AGENT_ASSISTANT_TURN_PHASES[number];
export type TAgentAssistantLoginMode = 'chatgpt' | 'device-code';
export const AGENT_ASSISTANT_MESSAGE_ROLES = [
    'user',
    'assistant',
    'system',
] as const;
export type TAgentAssistantMessageRole = typeof AGENT_ASSISTANT_MESSAGE_ROLES[number];
export const AGENT_ASSISTANT_EVENT_TYPES = [
    'state',
    'message',
    'message-delta',
    'reasoning-delta',
    'heartbeat',
    'turn-started',
    'turn-progress',
    'turn-completed',
    'install-progress',
    'error',
] as const;
export type TAgentAssistantEventType = typeof AGENT_ASSISTANT_EVENT_TYPES[number];
export type TAgentAssistantChatScopeKind = 'document';
export const ASSISTANT_PROVIDER_IDS = [
    'codex',
    'claude',
] as const;
export type TAgentAssistantProviderId = typeof ASSISTANT_PROVIDER_IDS[number];
export type TAgentAssistantModelSwitchMode = 'none' | 'in-session';
export const ASSISTANT_KNOWN_EFFORTS = [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
] as const;
export type TAgentAssistantKnownEffort = typeof ASSISTANT_KNOWN_EFFORTS[number];
export type TAgentAssistantEffort = TAgentAssistantKnownEffort | (string & {});
export type TAgentAssistantSpeedMode = 'fast' | 'standard';
export type TAgentWorkspaceMode = 'empty-workspace' | 'open-document' | 'documents-open-no-active-document';

export interface IAgentDocumentOcrState {
    status: TAgentOcrCoverageStatus;
    pageCount: number;
    textPageCount?: number;
    missingTextPages?: number[];
    coverage?: number;
}

export interface IAgentDocumentRecommendation {
    id: TAgentRecommendationId;
    title: string;
    reason: string;
    toolName?: string;
}

export interface IAgentCapabilityAvailability {
    available: boolean;
    reason?: string;
}

export interface IAgentCapabilityPolicy {
    internal: 'allow' | 'confirm' | 'deny';
    external: 'allow' | 'confirm' | 'deny';
}

export interface IAgentCapabilityDescriptor {
    id: string;
    domain: TAgentCapabilityDomain;
    title: string;
    summary: string;
    risk: TAgentCapabilityRisk;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    availability: IAgentCapabilityAvailability;
    policy: IAgentCapabilityPolicy;
    resourceTemplates?: string[];
}

export interface IAgentCompactCapabilityDescriptor extends Omit<IAgentCapabilityDescriptor, 'inputSchema' | 'outputSchema' | 'resourceTemplates'> {
    hasInputSchema: boolean;
    hasOutputSchema: boolean;
    hasResourceTemplates: boolean;
}

export interface IAgentDocumentReadiness {
    status: TAgentDocumentReadinessStatus;
    reasons: string[];
    ocr?: IAgentDocumentOcrState;
    recommendations: IAgentDocumentRecommendation[];
}

export interface IAgentPaneSnapshot {
    paneId: string;
    tabIds: string[];
    activeTabId: string | null;
}

export interface IAgentTabSnapshot {
    tabId: string;
    paneId: string | null;
    fileName: string | null;
    originalPath: string | null;
    originalBackend?: TDocumentBackend;
    documentSessionKey?: string | null;
    documentInstanceId?: TDocumentInstanceId | null;
    documentIdentity?: IDocumentRevisionInfo | null;
    commandTarget?: TAgentWorkspaceCommandTarget;
    isDirty: boolean;
    kind: TAgentDocumentKind;
    workspaceAttached: boolean;
    hasPdf: boolean;
    isDjvu: boolean;
    isOpeningDocument: boolean;
    hasOpenError: boolean;
    currentPage: number | null;
    totalPages: number | null;
    readiness: IAgentDocumentReadiness;
}

export interface IAgentDocumentReference {
    tabId: string;
    paneId: string | null;
    fileName: string | null;
    originalPath: TDocumentRef | null;
    originalBackend?: TDocumentBackend;
    documentSessionKey?: string | null;
    documentInstanceId?: TDocumentInstanceId | null;
    documentIdentity?: IDocumentRevisionInfo | null;
    commandTarget?: TAgentWorkspaceCommandTarget;
    kind: TAgentDocumentKind;
}

export type TAgentWorkspaceCommandTarget =
    | {
        kind: 'transaction';
        tabId: string;
        sessionId: string;
        documentRef: TDocumentRef | null;
        documentBackend?: TDocumentBackend;
        documentInstanceId?: TDocumentInstanceId | null;
        transactionId: string;
        documentRevisionToken?: TDocumentRevisionToken;
    }
    | {
        kind: 'revision';
        tabId: string;
        sessionId: string;
        documentRef: TDocumentRef | null;
        documentBackend?: TDocumentBackend;
        documentInstanceId?: TDocumentInstanceId | null;
        sessionRevision: number;
        documentRevisionToken?: TDocumentRevisionToken;
    };

export interface IAgentRecentFileSnapshot {
    fileName: string;
    originalPath: TDocumentRef;
    backend?: TDocumentBackend;
    kind: TAgentDocumentKind;
    openedAt: string;
    fileSize?: number;
}

export interface IAgentWorkspaceSummary {
    mode: TAgentWorkspaceMode;
    activeDocument: IAgentDocumentReference | null;
    documentCount: number;
    recentFileCount: number;
    recentFilesResolved: boolean;
}

export interface IAgentWorkspaceSnapshot {
    capturedAt: string;
    activePaneId: string | null;
    activeTabId: string | null;
    summary: IAgentWorkspaceSummary;
    panes: IAgentPaneSnapshot[];
    tabs: IAgentTabSnapshot[];
    recentFiles: IAgentRecentFileSnapshot[];
    layout: TEditorLayoutNode | null;
}

export interface IAgentCommandExecutionScope {
    windowId: number;
    tabId: string;
    documentRef: TDocumentRef | null;
    documentBackend?: TDocumentBackend;
    documentInstanceId?: TDocumentInstanceId | null;
    documentIdentity: IDocumentRevisionInfo | null;
    commandTarget?: TAgentWorkspaceCommandTarget;
}

export interface IAgentWorkspaceSnapshotRequest {
    requestId: string;
    windowId?: number;
    lastSeenRevision?: number;
    scope?: IAgentCommandExecutionScope;
}

export interface IAgentWorkspaceSnapshotResponse {
    requestId: string;
    windowId?: number;
    ok: boolean;
    snapshot?: IAgentWorkspaceSnapshot;
    revision?: number;
    unchanged?: boolean;
    error?: string;
}

export interface IAgentActivateTabCommand {
    name: 'activate_tab';
    arguments: {tabId: string;};
}

export interface IAgentGoToPageCommand {
    name: 'go_to_page';
    arguments: {
        page: number;
        tabId?: string;
    };
}

export interface IAgentRunActionCommand {
    name: 'run_action';
    arguments: {
        id: string;
        tabId?: string;
        input?: Record<string, unknown>;
        dryRun?: boolean;
    };
}

export interface IAgentReadResourceCommand {
    name: 'read_resource';
    arguments: {
        uri: string;
        tabId?: string;
    };
}

export type TAgentCommand =
    | IAgentActivateTabCommand
    | IAgentGoToPageCommand
    | IAgentRunActionCommand
    | IAgentReadResourceCommand;

export interface IAgentCommandRequest {
    requestId: string;
    windowId?: number;
    scope?: IAgentCommandExecutionScope;
    command: TAgentCommand;
}

export interface IAgentCommandCancelRequest {
    requestId: string;
    windowId?: number;
}

export interface IAgentCommandResponse {
    requestId: string;
    windowId?: number;
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
}

export type TAgentRendererAckReason =
    | 'invalid-payload'
    | 'unexpected-sender'
    | 'unknown-request';

export interface IAgentRendererAck {
    accepted: boolean;
    reason?: TAgentRendererAckReason;
}

export interface IAgentMcpSetupSnippets {
    codex: string;
    claude: string;
    cursor: string;
}

export interface IAgentMcpIntegrationStatus {
    enabled: boolean;
    serverName: string;
    serverUrl: string;
    serverRunning: boolean;
    codexInstalled: boolean;
    codexPath: string | null;
    codexConfigured: boolean;
    codexRegistrationState: TAgentMcpCodexRegistrationState;
    installUrl: string;
    lastCheckedAt: string;
    setupSnippets?: IAgentMcpSetupSnippets;
    error?: string;
}

export interface IAgentMcpIntegrationUpdateResult {
    ok: boolean;
    cancelled?: boolean;
    status: IAgentMcpIntegrationStatus;
    error?: string;
}

export const AGENT_ASSISTANT_ERROR_CODES = [
    'AUTH_REQUIRED',
    'INSTALL_MISSING',
    'LOGIN_CANCELLED',
    'USER_INTERRUPTED',
    'MODEL_UNAVAILABLE',
    'RUNTIME_UNAVAILABLE',
    'PROVIDER_RATE_LIMITED',
    'INTERNAL',
] as const;
export type TAgentAssistantErrorCode = typeof AGENT_ASSISTANT_ERROR_CODES[number];

export interface IAgentAssistantErrorEnvelope {
    code: TAgentAssistantErrorCode;
    message: string;
    retryable: boolean;
    timestamp: number;
}

export interface IAgentAssistantAccount {
    type: 'chatgpt' | 'apiKey' | 'other';
    email?: string;
    planType?: string;
}

export interface IAgentAssistantMcpStatus {
    serverName: string;
    serverUrl: string;
    serverRunning: boolean;
    toolCount: number;
}

export interface IAgentAssistantModelOption {
    id: string;
    label: string;
    reasoningEfforts?: readonly IAgentAssistantEffortOption[];
    defaultReasoningEffort?: TAgentAssistantEffort | null;
    serviceTiers?: readonly IAgentAssistantServiceTierOption[];
    defaultServiceTier?: string | null;
}

export interface IAgentAssistantEffortOption {
    id: TAgentAssistantEffort;
    label: string;
    description?: string;
    isDefault?: boolean;
}

export interface IAgentAssistantServiceTierOption {
    id: string;
    label: string;
    description?: string;
    isDefault?: boolean;
}

export interface IAgentAssistantProviderStatus {
    id: TAgentAssistantProviderId;
    label: string;
    installState: TAgentAssistantInstallState;
    authState: TAgentAssistantAuthState;
    runtimeState: TAgentAssistantRuntimeState;
    models: readonly IAgentAssistantModelOption[];
    defaultModel: string;
    activeModel: string;
    modelSwitchMode: TAgentAssistantModelSwitchMode;
    availableEfforts: readonly TAgentAssistantEffort[];
    defaultEffort: TAgentAssistantEffort;
    activeEffort: TAgentAssistantEffort;
    availableSpeedModes: readonly TAgentAssistantSpeedMode[];
    defaultSpeedMode: TAgentAssistantSpeedMode;
    activeSpeedMode: TAgentAssistantSpeedMode;
    path: string | null;
    version: string | null;
    minimumVersion: string | null;
    versionSupported: boolean;
    installUrl: string;
    account: IAgentAssistantAccount | null;
    error?: string;
    errorEnvelope?: IAgentAssistantErrorEnvelope;
}

export interface IAgentAssistantChatScope {
    kind: TAgentAssistantChatScopeKind;
    key: string;
    title: string | null;
    tabId?: string | null;
    documentSessionKey?: string | null;
    documentInstanceId?: TDocumentInstanceId | null;
    documentRef?: TDocumentRef | null;
    documentBackend?: TDocumentBackend;
    documentIdentity?: IDocumentRevisionInfo | null;
    commandTarget?: TAgentWorkspaceCommandTarget;
}

export function getAgentAssistantScopeRevisionToken(scope: IAgentAssistantChatScope | null | undefined) {
    return scope?.commandTarget?.documentRevisionToken
        ?? scope?.documentIdentity?.token
        ?? null;
}

export function buildAgentAssistantScopeFingerprint(
    provider: TAgentAssistantProviderId,
    scope: IAgentAssistantChatScope | null | undefined,
) {
    return JSON.stringify({
        provider,
        scopeKey: scope?.key ?? null,
        tabId: scope?.tabId ?? null,
        documentSessionKey: scope?.documentSessionKey ?? scope?.key ?? null,
        documentInstanceId: scope?.documentInstanceId ?? scope?.commandTarget?.documentInstanceId ?? null,
        documentRef: scope?.documentRef ?? scope?.commandTarget?.documentRef ?? null,
        documentRevisionToken: getAgentAssistantScopeRevisionToken(scope),
    });
}

export interface IAgentAssistantStatus {
    supported: boolean;
    platform: string;
    provider: TAgentAssistantProviderId;
    providerLabel: string;
    providers: readonly IAgentAssistantProviderStatus[];
    model: string;
    modelLabel: string;
    models: readonly IAgentAssistantModelOption[];
    modelSwitchMode: TAgentAssistantModelSwitchMode;
    effort: TAgentAssistantEffort;
    availableEfforts: readonly TAgentAssistantEffort[];
    speedMode: TAgentAssistantSpeedMode;
    availableSpeedModes: readonly TAgentAssistantSpeedMode[];
    installState: TAgentAssistantInstallState;
    codexInstalled: boolean;
    codexPath: string | null;
    codexVersion: string | null;
    minimumCodexVersion: string;
    codexVersionSupported: boolean;
    installUrl: string;
    installScriptUrl: string;
    managedInstallDir: string;
    authState: TAgentAssistantAuthState;
    account: IAgentAssistantAccount | null;
    runtimeState: TAgentAssistantRuntimeState;
    mcp: IAgentAssistantMcpStatus;
    turn: IAgentAssistantTurnState;
    lastCheckedAt: string;
    error?: string;
    errorEnvelope?: IAgentAssistantErrorEnvelope;
}

export interface IAgentAssistantTurnState {
    id: string | null;
    phase: TAgentAssistantTurnPhase;
    reasoning: string;
    toolActivity: IAgentAssistantToolActivity[];
    lastEventAtMs: number | null;
    usage: IAgentAssistantTokenUsage | null;
}

export interface IAgentAssistantTokenUsage {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
}

export interface IAgentAssistantToolActivity {
    toolId: string;
    name: string;
    phase: 'running' | 'completed' | 'failed';
    startedAtMs: number;
    completedAtMs?: number;
}

export interface IAgentAssistantChatMessage {
    id: string;
    role: TAgentAssistantMessageRole;
    text: string;
    createdAt: string;
    attachments?: IAgentAssistantImageAttachment[];
    pending?: boolean;
    error?: string;
    errorEnvelope?: IAgentAssistantErrorEnvelope;
}

export interface IAgentAssistantImageAttachment {
    type: 'image';
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    dataUrl: string;
}

export interface IAgentAssistantState {
    scope: IAgentAssistantChatScope | null;
    status: IAgentAssistantStatus;
    messages: IAgentAssistantChatMessage[];
}

export interface IAgentAssistantStateRequest {
    scope?: IAgentAssistantChatScope | null;
    provider?: TAgentAssistantProviderId;
    model?: string;
    effort?: TAgentAssistantEffort;
    speedMode?: TAgentAssistantSpeedMode;
}

export interface IAgentAssistantInstallResult {
    ok: boolean;
    state: IAgentAssistantState;
    error?: string;
    errorEnvelope?: IAgentAssistantErrorEnvelope;
}

export interface IAgentAssistantLoginRequest {mode: TAgentAssistantLoginMode;}

export interface IAgentAssistantLoginResult {
    ok: boolean;
    state: IAgentAssistantState;
    loginId?: string;
    authUrl?: string;
    verificationUrl?: string;
    userCode?: string;
    error?: string;
    errorEnvelope?: IAgentAssistantErrorEnvelope;
}

export const AGENT_ASSISTANT_PRESET_IDS = [
    'add-bookmarks',
    'number-pages',
    'check-ocr-readiness',
] as const;
export type TAgentAssistantPresetId = typeof AGENT_ASSISTANT_PRESET_IDS[number];

export interface IAgentAssistantSendMessageRequest {
    text: string;
    scope?: IAgentAssistantChatScope | null;
    provider?: TAgentAssistantProviderId;
    model?: string;
    effort?: TAgentAssistantEffort;
    speedMode?: TAgentAssistantSpeedMode;
    attachments?: IAgentAssistantImageAttachment[];
    presetId?: TAgentAssistantPresetId;
}

export interface IAgentAssistantSendMessageResult {
    ok: boolean;
    state: IAgentAssistantState;
    error?: string;
    errorEnvelope?: IAgentAssistantErrorEnvelope;
}

export interface IAgentAssistantScopedRequest {
    scope?: IAgentAssistantChatScope | null;
    provider?: TAgentAssistantProviderId;
    model?: string;
    effort?: TAgentAssistantEffort;
    speedMode?: TAgentAssistantSpeedMode;
}

export interface IAgentAssistantEvent {
    type: TAgentAssistantEventType;
    state?: IAgentAssistantState;
    message?: IAgentAssistantChatMessage;
    messageId?: string;
    delta?: string;
    reasoningDelta?: string;
    turnId?: string;
    phase?: TAgentAssistantTurnPhase;
    toolActivity?: IAgentAssistantToolActivity;
    lastEventAtMs?: number;
    progress?: string;
    error?: string;
    errorEnvelope?: IAgentAssistantErrorEnvelope;
    /** Immutable identity of the document-bound turn that produced this event. */
    binding?: IAgentAssistantEventBinding;
}

export interface IAgentAssistantEventBinding {
    scopeFingerprint: string;
    sessionKey: string;
    turnGeneration: number;
    windowId: number;
}
