import type { TEditorLayoutNode } from '@contracts/editorPanes';

export type TAgentDocumentKind = 'empty' | 'pdf' | 'djvu' | 'image' | 'unknown';
export type TAgentDocumentReadinessStatus = 'ready' | 'needs-preparation' | 'unknown' | 'empty';
export type TAgentOcrCoverageStatus = 'complete' | 'partial' | 'none' | 'unknown';
export type TAgentRecommendationId = 'convert_to_pdf' | 'ocr_all_pages';
export type TAgentCommandName = 'activate_tab' | 'go_to_page';
export type TAgentMcpCodexRegistrationState = 'configured' | 'missing' | 'mismatched' | 'unknown';

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

export interface IAgentWorkspaceSnapshot {
    capturedAt: string;
    activePaneId: string | null;
    activeTabId: string | null;
    panes: IAgentPaneSnapshot[];
    tabs: IAgentTabSnapshot[];
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

export type TAgentCommand = IAgentActivateTabCommand | IAgentGoToPageCommand;

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
