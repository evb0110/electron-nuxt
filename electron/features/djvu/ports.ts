import type { IpcMainInvokeEvent } from 'electron';
import type { IIpcMainRegistrar as IContractIpcMainRegistrar } from '@contracts/ipcMain';
import type { IDjvuInvokeMap } from '@electron/features/djvu/contract';

export type TDjvuIpcMainRegistrar = IContractIpcMainRegistrar<IDjvuInvokeMap, IpcMainInvokeEvent>;

export interface IDjvuService {registerHandlers: (registrar: TDjvuIpcMainRegistrar) => void;}
