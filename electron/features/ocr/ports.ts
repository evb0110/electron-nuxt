import type { IpcMainInvokeEvent } from 'electron';
import type { IIpcMainRegistrar as IContractIpcMainRegistrar } from '@contracts/ipcMain';
import type { IOcrInvokeMap } from '@electron/features/ocr/contract';

export type TOcrIpcMainRegistrar = IContractIpcMainRegistrar<IOcrInvokeMap, IpcMainInvokeEvent>;

export interface IOcrService {registerHandlers: (registrar: TOcrIpcMainRegistrar) => void;}
