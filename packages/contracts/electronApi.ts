import type { IDocumentsCapability } from '@contracts/electronApiDocuments';
import type { IPlatformApi } from '@contracts/platformApi';

export type * from '@contracts/agent';
export type * from '@contracts/agentCapability';
export type * from '@contracts/pdfConformance';
export type * from '@contracts/electronApiCommon';
export type * from '@contracts/electronApiDocuments';
export type * from '@contracts/electronApiOcr';
export type * from '@contracts/electronApiUpdates';
export type * from '@contracts/electronApiWindowTabs';
export type * from '@contracts/electronApiDjvu';
export type * from '@contracts/electronApiPageOps';
export type * from '@contracts/electronApiHost';
export type * from '@contracts/searchCapability';
export type * from '@contracts/settingsCapability';
export type * from '@contracts/shellCapability';

export interface IElectronAPI extends IPlatformApi {documents: IDocumentsCapability;}
