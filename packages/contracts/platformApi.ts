import type { IAgentCapability } from '@contracts/agentCapability';
import type { IDjvuCapability } from '@contracts/electronApiDjvu';
import type {
    IDocumentsCapability,
    IImageExportCapability,
} from '@contracts/electronApiDocuments';
import type { IHostCapability } from '@contracts/electronApiHost';
import type { IOcrCapability } from '@contracts/electronApiOcr';
import type { IPageOpsCapability } from '@contracts/electronApiPageOps';
import type { ISearchCapability } from '@contracts/searchCapability';
import type { ISettingsCapability } from '@contracts/settingsCapability';
import type { IShellCapability } from '@contracts/shellCapability';
import type { IUpdatesCapability } from '@contracts/electronApiUpdates';
import type { IWindowTabsCapability } from '@contracts/electronApiWindowTabs';

export interface IPlatformApi {
    documents: IDocumentsCapability;
    pageOps: IPageOpsCapability;
    imageExport: IImageExportCapability;
    ocr: IOcrCapability;
    search: ISearchCapability;
    djvu: IDjvuCapability;
    settings: ISettingsCapability;
    updates: IUpdatesCapability;
    windowTabs: IWindowTabsCapability;
    shell: IShellCapability;
    host: IHostCapability;
    agent: IAgentCapability;
}

export type { TDocumentRef } from '@contracts/documentRef';
export type {
    IDesktopMenuCapability,
    IDesktopWindowCapability,
    IViewerAssetResolver,
    IViewerDocumentCapability,
    IViewerDocumentOutputCapability,
    IViewerDocumentPickerCapability,
    IViewerDocumentReadCapability,
    IViewerHostApi,
    IViewerHostEnvironment,
    IViewerSearchCapability,
    IViewerSettingsCapability,
    TViewerHostKind,
} from '@contracts/viewerHost';

export type {
    IAppUpdateStatus,
    IAgentCapability,
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentDocumentOcrState,
    IAgentDocumentReadiness,
    IAgentDocumentRecommendation,
    IAgentMcpIntegrationStatus,
    IAgentMcpIntegrationUpdateResult,
    IAgentPaneSnapshot,
    IAgentTabSnapshot,
    IAgentWorkspaceSnapshot,
    IAgentWorkspaceSnapshotRequest,
    IAgentWorkspaceSnapshotResponse,
    IDebugLogEntry,
    IDjvuCapability,
    IDjvuInfo,
    IDjvuProgress,
    IDjvuSizeEstimate,
    IDjvuViewingErrorEvent,
    IDjvuViewingReadyEvent,
    IDocumentsCapability,
    IDocumentsFileCapability,
    IDocumentsMenuCapability,
    IHostCapability,
    IHostEnvironmentSnapshot,
    IImageExportCapability,
    IMenuEventCallback,
    IMenuEventUnsubscribe,
    IOcrCapability,
    IPageOpsCapability,
    IRendererLogEntry,
    ISearchCapability,
    ISettingsCapability,
    IUpdatesCapability,
    IWindowTabsCapability,
    TAppUpdateCheckOrigin,
    TAppUpdatePhase,
    THostPlatform,
    TOpenFileResult,
    TPdfSaveMode,
    IPdfConformanceProfile,
    IPdfValidationResult,
    TAgentCommand,
    TAgentCommandName,
    TAgentDocumentKind,
    TAgentDocumentReadinessStatus,
    TAgentMcpCodexRegistrationState,
    TAgentOcrCoverageStatus,
    TAgentRecommendationId,
} from '@contracts/electronApi';
