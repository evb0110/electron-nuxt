import type { IPlatformApi } from '@contracts/platformApi';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IEvbTestApi } from '@app/types/evbTestApi';

declare global {
    interface Window {
        electronAPI?: IPlatformApi;
        __allowRendererFileOpenForAutomation?: (path: TDocumentRef) => Promise<boolean>;
        __evbTestApi?: IEvbTestApi;
        __openFileDirect?: (path: TDocumentRef) => Promise<boolean>;
        __handleSave?: () => Promise<unknown>;
        __appReady?: boolean;
        __appReadyAt?: number;
        __logLevel?: unknown;
    }
}

export {};
