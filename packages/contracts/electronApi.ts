import type { IDocumentsCapability } from './electronApiDocuments';
import type { IPlatformApi } from './platformApi';

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

export interface IElectronAPI extends IPlatformApi {documents: IDocumentsCapability;}
