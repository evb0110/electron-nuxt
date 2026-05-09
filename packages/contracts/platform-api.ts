import type { IElectronAPI } from './electron-api';

export interface IPlatformApi extends IElectronAPI {}

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
} from './viewer-host';

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
    IElectronAPI,
    TAppUpdateCheckOrigin,
    TAppUpdatePhase,
    THostPlatform,
    TOpenFileResult,
    TPdfSaveMode,
    IPdfConformanceProfile,
    IPdfValidationResult,
} from './electron-api';
