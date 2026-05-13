import type { IDocumentsCapability } from './electronApiDocuments';
import type { IDjvuCapability } from './electronApiDjvu';
import type { IHostCapability } from './electronApiHost';
import type { IOcrCapability } from './electronApiOcr';
import type { ISearchCapability } from './electronApiSearch';
import type { ISettingsCapability } from './electronApiSettings';
import type { IShellCapability } from './electronApiShell';
import type { IUpdatesCapability } from './electronApiUpdates';
import type { IWindowTabsCapability } from './electronApiWindowTabs';

export type * from './pdfConformance';
export type * from './electronApiCommon';
export type * from './electronApiDocuments';
export type * from './electronApiOcr';
export type * from './electronApiUpdates';
export type * from './electronApiWindowTabs';
export type * from './electronApiDjvu';
export type * from './electronApiPageOps';
export type * from './electronApiHost';
export type * from './electronApiSearch';
export type * from './electronApiSettings';
export type * from './electronApiShell';

export interface IElectronAPI {
    documents: IDocumentsCapability;
    ocr: IOcrCapability;
    search: ISearchCapability;
    djvu: IDjvuCapability;
    settings: ISettingsCapability;
    updates: IUpdatesCapability;
    windowTabs: IWindowTabsCapability;
    shell: IShellCapability;
    host: IHostCapability;
}
