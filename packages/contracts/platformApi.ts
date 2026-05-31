import type { IDjvuCapability } from './electronApiDjvu';
import type {
    IDocumentsCapability,
    IImageExportCapability,
} from './electronApiDocuments';
import type { IHostCapability } from './electronApiHost';
import type { IOcrCapability } from './electronApiOcr';
import type { IPageOpsCapability } from './electronApiPageOps';
import type { ISearchCapability } from './electronApiSearch';
import type { ISettingsCapability } from './electronApiSettings';
import type { IShellCapability } from './electronApiShell';
import type { IUpdatesCapability } from './electronApiUpdates';
import type { IWindowTabsCapability } from './electronApiWindowTabs';

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

export type { TDocumentRef } from './document';
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
} from './viewerHost';

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
} from './electronApi';
