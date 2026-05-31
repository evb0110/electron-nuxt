import type { IIpcMainRegistrar as IContractIpcMainRegistrar } from '@contracts/ipcMain';
import type { IOcrInvokeMap } from '@electron/features/ocr/contract';

export type IIpcMainRegistrar = IContractIpcMainRegistrar<IOcrInvokeMap>;

export interface IOcrService {registerHandlers: (registrar: IIpcMainRegistrar) => void;}
