import type { IpcMainInvokeEvent } from 'electron';
import type { IIpcMainRegistrar as IContractIpcMainRegistrar } from '@contracts/ipcMain';
import type { IPageOpsInvokeMap } from '@electron/features/page-ops/contract';

export type TPageOpsIpcMainRegistrar = IContractIpcMainRegistrar<IPageOpsInvokeMap, IpcMainInvokeEvent>;

export interface IPageOpsService {registerHandlers: (registrar: TPageOpsIpcMainRegistrar) => void;}
