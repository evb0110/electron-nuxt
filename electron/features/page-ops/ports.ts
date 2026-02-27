import type { IpcMain } from 'electron';

export interface IIpcMainRegistrar {handle: IpcMain['handle'];}

export interface IPageOpsService {registerHandlers: (registrar: IIpcMainRegistrar) => void;}
