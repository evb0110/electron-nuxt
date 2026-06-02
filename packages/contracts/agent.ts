import type { TEditorLayoutNode } from '@contracts/editorPanes';
import type { TDocumentRef } from '@contracts/document';

export type TAgentDocumentKind = 'empty' | 'pdf' | 'djvu' | 'image' | 'unknown';
export type TAgentDocumentReadinessStatus = 'ready' | 'needs-preparation' | 'unknown' | 'empty';
export type TAgentOcrCoverageStatus = 'complete' | 'partial' | 'none' | 'unknown';
export type TAgentRecommendationId = 'convert_to_pdf' | 'ocr_all_pages';
export type TAgentCapabilityDomain = 'workspace' | 'document' | 'annotation' | 'toc' | 'ocr' | 'ui' | 'view' | 'file' | 'export' | 'pageOps';
export type TAgentCapabilityRisk = 'read' | 'navigate' | 'write' | 'destructive' | 'longRunning';
export type TAgentCommandName = 'activate_tab' | 'go_to_page' | 'run_action' | 'read_resource';
export type TAgentMcpCodexRegistrationState = 'configured' | 'missing' | 'mismatched' | 'unknown';
export type TAgentAssistantInstallState = 'installed' | 'missing' | 'unsupported';
export type TAgentAssistantAuthState = 'signed-in' | 'signed-out' | 'login-pending' | 'unknown';
export type TAgentAssistantRuntimeState = 'stopped' | 'starting' | 'ready' | 'busy' | 'error';
export type TAgentAssistantTurnPhase = 'idle' | 'starting' | 'running' | 'interrupting' | 'error';
export type TAgentAssistantLoginMode = 'chatgpt' | 'device-code';
export type TAgentAssistantMessageRole = 'user' | 'assistant' | 'system';
export type TAgentAssistantEventType = 'state' | 'message' | 'message-delta' | 'turn-started' | 'turn-completed' | 'install-progress' | 'error';
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
    kind: TAgentDocumentKind;
}

export interface IAgentRecentFileSnapshot {
    fileName: string;
    originalPath: TDocumentRef;
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

export interface IAgentWorkspaceSnapshotRequest {
    requestId: string;
    windowId?: number;
}

export interface IAgentWorkspaceSnapshotResponse {
    requestId: string;
    windowId?: number;
    ok: boolean;
    snapshot?: IAgentWorkspaceSnapshot;
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
    command: TAgentCommand;
}

export interface IAgentCommandResponse {
    requestId: string;
    windowId?: number;
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
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
    error?: string;
}

export interface IAgentMcpIntegrationUpdateResult {
    ok: boolean;
    cancelled?: boolean;
    status: IAgentMcpIntegrationStatus;
    error?: string;
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

export interface IAgentAssistantStatus {
    supported: boolean;
    platform: string;
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
    threadId: string | null;
    activeTurnId: string | null;
    lastCheckedAt: string;
    error?: string;
}

export interface IAgentAssistantTurnState {
    id: string | null;
    phase: TAgentAssistantTurnPhase;
}

export interface IAgentAssistantChatMessage {
    id: string;
    role: TAgentAssistantMessageRole;
    text: string;
    createdAt: string;
    attachments?: IAgentAssistantImageAttachment[];
    pending?: boolean;
    error?: string;
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
    status: IAgentAssistantStatus;
    messages: IAgentAssistantChatMessage[];
}

export interface IAgentAssistantInstallResult {
    ok: boolean;
    state: IAgentAssistantState;
    error?: string;
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
}

export interface IAgentAssistantSendMessageRequest {
    text: string;
    attachments?: IAgentAssistantImageAttachment[];
}

export interface IAgentAssistantSendMessageResult {
    ok: boolean;
    state: IAgentAssistantState;
    error?: string;
}

export interface IAgentAssistantEvent {
    type: TAgentAssistantEventType;
    state?: IAgentAssistantState;
    message?: IAgentAssistantChatMessage;
    messageId?: string;
    delta?: string;
    turnId?: string;
    progress?: string;
    error?: string;
}
