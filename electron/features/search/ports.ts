import type { IIpcMainRegistrar as IContractIpcMainRegistrar } from '@contracts/ipcMain';
import type { ISearchInvokeMap } from '@electron/features/search/contract';

type IIpcMainRegistrar = IContractIpcMainRegistrar<ISearchInvokeMap>;
export type { IIpcMainRegistrar };

export interface ISearchService {registerHandlers: (registrar: IIpcMainRegistrar) => void;}
