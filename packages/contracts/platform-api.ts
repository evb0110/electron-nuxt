import type { IElectronAPI } from './electron-api';

export interface IPlatformApi extends IElectronAPI {}

export type { TDocumentRef } from './document';

export type {
    IAppUpdateStatus,
    IDebugLogEntry,
    IDjvuCapability,
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
    IShellCapability,
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
