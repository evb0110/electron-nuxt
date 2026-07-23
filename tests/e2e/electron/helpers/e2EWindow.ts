import type { IPlatformApi } from '@contracts/platformApi';
import type { IElectronAPI } from '@contracts/electronApi';
import type { TDocumentRef } from '@contracts/documentRef';

export interface IE2EWindow extends Window {
    __e2eOpenExternalCalls?: string[];
    __e2eOriginalOpenExternal?: IPlatformApi['shell']['openExternal'];
    __openFileDirect?: (path: TDocumentRef) => Promise<boolean>;
    electronAPI?: IElectronAPI;
}
