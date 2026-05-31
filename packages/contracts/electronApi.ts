import type { IDocumentsCapability } from '@contracts/electronApiDocuments';
import type { IPlatformApi } from '@contracts/platformApi';

export type * from '@contracts/pdfConformance';
export type * from '@contracts/electronApiCommon';
export type * from '@contracts/electronApiDocuments';
export type * from '@contracts/electronApiOcr';
export type * from '@contracts/electronApiUpdates';
export type * from '@contracts/electronApiWindowTabs';
export type * from '@contracts/electronApiDjvu';
export type * from '@contracts/electronApiPageOps';
export type * from '@contracts/electronApiHost';
export type * from '@contracts/electronApiSearch';
export type * from '@contracts/electronApiSettings';
export type * from '@contracts/electronApiShell';

export interface IElectronAPI extends IPlatformApi {documents: IDocumentsCapability;}
