import type { IpcMain } from 'electron';

export interface IIpcMainRegistrar {handle: IpcMain['handle'];}

export interface IOcrService {registerHandlers: (registrar: IIpcMainRegistrar) => void;}
