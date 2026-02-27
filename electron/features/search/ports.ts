import type { IpcMain } from 'electron';

export interface IIpcMainRegistrar {handle: IpcMain['handle'];}

export interface ISearchService {registerHandlers: (registrar: IIpcMainRegistrar) => void;}
