import type { IIpcMainRegistrar } from '@contracts/ipc-main';
export type { IIpcMainRegistrar };

export interface ISearchService {registerHandlers: (registrar: IIpcMainRegistrar) => void;}
