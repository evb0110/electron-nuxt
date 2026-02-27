import type { IpcMain } from 'electron';

export interface IIpcMainRegistrar {handle: IpcMain['handle'];}

export interface IDjvuService {registerHandlers: (registrar: IIpcMainRegistrar) => void;}
