import type { IpcMainInvokeEvent } from 'electron';
import type { IIpcMainRegistrar as IContractIpcMainRegistrar } from '@contracts/ipcMain';
import type { ISearchInvokeMap } from '@electron/features/search/contract';

type TSearchIpcMainRegistrar = IContractIpcMainRegistrar<ISearchInvokeMap, IpcMainInvokeEvent>;
export type { TSearchIpcMainRegistrar };

export interface ISearchService {registerHandlers: (registrar: TSearchIpcMainRegistrar) => void;}
