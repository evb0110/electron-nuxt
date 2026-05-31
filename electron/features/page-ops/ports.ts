import type { IIpcMainRegistrar as IContractIpcMainRegistrar } from '@contracts/ipcMain';
import type { IPageOpsInvokeMap } from '@electron/features/page-ops/contract';

export type IIpcMainRegistrar = IContractIpcMainRegistrar<IPageOpsInvokeMap>;

export interface IPageOpsService {registerHandlers: (registrar: IIpcMainRegistrar) => void;}
