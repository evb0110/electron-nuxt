import type { IDjvuCapability } from '@contracts/electronApiDjvu';
import type {
    IDocumentsCapability,
    IImageExportCapability,
} from '@contracts/electronApiDocuments';
import type { IHostCapability } from '@contracts/electronApiHost';
import type { IOcrCapability } from '@contracts/electronApiOcr';
import type { IPageOpsCapability } from '@contracts/electronApiPageOps';
import type { ISearchCapability } from '@contracts/electronApiSearch';
import type { ISettingsCapability } from '@contracts/electronApiSettings';
import type { IShellCapability } from '@contracts/electronApiShell';
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
}

export type { TDocumentRef } from '@contracts/document';
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
} from '@contracts/electronApi';
