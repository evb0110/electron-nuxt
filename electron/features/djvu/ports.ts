import type { IIpcMainRegistrar as IContractIpcMainRegistrar } from '@contracts/ipcMain';
import type { IDjvuInvokeMap } from '@electron/features/djvu/contract';

export type IIpcMainRegistrar = IContractIpcMainRegistrar<IDjvuInvokeMap>;

export interface IDjvuService {registerHandlers: (registrar: IIpcMainRegistrar) => void;}
