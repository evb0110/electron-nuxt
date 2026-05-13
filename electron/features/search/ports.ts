import type { IIpcMainRegistrar } from '@contracts/ipcMain';
export type { IIpcMainRegistrar };

export interface ISearchService {registerHandlers: (registrar: IIpcMainRegistrar) => void;}
