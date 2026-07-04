import type { IAgentCapability } from '@contracts/agentCapability';
import type { IDjvuCapability } from '@contracts/electronApiDjvu';
import type {
    IDocumentsCapability,
    IDocumentsFileIoCapability,
    IImageExportCapability,
    IDocumentsMenuCapability,
    IDocumentsOpenCapability,
    IDocumentsPdfCapability,
    IDocumentsPickerCapability,
    IDocumentsRecentFilesCapability,
    IDocumentsWindowCapability,
    IDocumentsWorkingCopyCapability,
} from '@contracts/electronApiDocuments';
import type { IHostCapability } from '@contracts/electronApiHost';
import type { IOcrCapability } from '@contracts/electronApiOcr';
import type { IPageOpsCapability } from '@contracts/electronApiPageOps';
import type { ISearchCapability } from '@contracts/searchCapability';
import type { ISettingsCapability } from '@contracts/settingsCapability';
import type { IShellCapability } from '@contracts/shellCapability';
import type { ISystemCapability } from '@contracts/electronApiSystem';
import type { IUpdatesCapability } from '@contracts/electronApiUpdates';
import type { IWindowTabsCapability } from '@contracts/electronApiWindowTabs';
import type { IPlatformRuntimeManifest } from '@contracts/platformManifest';
export type * from '@contracts/platformManifest';
export type * from '@contracts/platformApiDescriptor';
export {
    BROWSER_PLATFORM_MANIFEST,
    ELECTRON_PLATFORM_MANIFEST,
    PLATFORM_CONTRACT_VERSION,
} from '@contracts/platformManifest';
export {
    getPlatformDocumentCapabilityMirrors,
    getPlatformMethodDescriptor,
    PLATFORM_API_DESCRIPTOR,
} from '@contracts/platformApiDescriptor';

export interface IPlatformApi {
    manifest: IPlatformRuntimeManifest;
    documents: IDocumentsCapability;
    documentPicker?: IDocumentsPickerCapability;
    documentOpen?: IDocumentsOpenCapability;
    documentWorkingCopy?: IDocumentsWorkingCopyCapability;
    documentFiles?: IDocumentsFileIoCapability;
    documentPdf?: IDocumentsPdfCapability;
    documentRecentFiles?: IDocumentsRecentFilesCapability;
    documentWindow?: IDocumentsWindowCapability;
    documentMenu?: IDocumentsMenuCapability;
    pageOps: IPageOpsCapability;
    imageExport: IImageExportCapability;
    ocr: IOcrCapability;
    search: ISearchCapability;
    djvu: IDjvuCapability;
    settings: ISettingsCapability;
    system: ISystemCapability;
    updates: IUpdatesCapability;
    windowTabs: IWindowTabsCapability;
    shell: IShellCapability;
    host: IHostCapability;
    agent: IAgentCapability;
}

export type { TDocumentRef } from '@contracts/documentRef';
export type * from '@contracts/platformUnsupported';
export type * from '@contracts/documentRevision';
export type * from '@contracts/shared';
export type * from '@contracts/geometry';
export type * from '@contracts/pageNumbers';
export type * from '@contracts/pdfPageLabels';
export type * from '@contracts/annotations';
export type * from '@contracts/viewerHost';
export type * from '@contracts/agent';
export type * from '@contracts/agentCapability';
export type * from '@contracts/electronApiCommon';
export type * from '@contracts/electronApiDocuments';
export type * from '@contracts/electronApiDjvu';
export type * from '@contracts/electronApiHost';
export type * from '@contracts/electronApiOcr';
export type * from '@contracts/electronApiPageOps';
export type * from '@contracts/electronApiSystem';
export type * from '@contracts/electronApiUpdates';
export type * from '@contracts/electronApiWindowTabs';
export type * from '@contracts/searchCapability';
export type * from '@contracts/settingsCapability';
export type * from '@contracts/shellCapability';
export type * from '@contracts/pdfConformance';
