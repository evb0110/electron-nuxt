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
    TOpenFileResult,
    TPdfSaveMode,
    IPdfConformanceProfile,
    IPdfValidationResult,
} from './electron-api';
