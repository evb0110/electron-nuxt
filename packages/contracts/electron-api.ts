import type { IDocumentsCapability } from './electron-api-documents';
import type { IDjvuCapability } from './electron-api-djvu';
import type { IHostCapability } from './electron-api-host';
import type { IOcrCapability } from './electron-api-ocr';
import type { ISearchCapability } from './electron-api-search';
import type { ISettingsCapability } from './electron-api-settings';
import type { IShellCapability } from './electron-api-shell';
import type { IUpdatesCapability } from './electron-api-updates';
import type { IWindowTabsCapability } from './electron-api-window-tabs';

export type * from './pdf-conformance';
export type * from './electron-api-common';
export type * from './electron-api-documents';
export type * from './electron-api-ocr';
export type * from './electron-api-updates';
export type * from './electron-api-window-tabs';
export type * from './electron-api-djvu';
export type * from './electron-api-page-ops';
export type * from './electron-api-host';
export type * from './electron-api-search';
export type * from './electron-api-settings';
export type * from './electron-api-shell';

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
