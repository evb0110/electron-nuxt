import type { IPlatformApi } from '@contracts/platformApi';
import type { TDocumentRef } from '@contracts/documentRef';

declare global {
    interface Window {
        electronAPI?: IPlatformApi;
        __allowRendererFileOpenForAutomation?: (path: TDocumentRef) => Promise<boolean>;
        __openFileDirect?: (path: TDocumentRef) => Promise<boolean>;
        __handleSave?: () => Promise<unknown>;
        __appReady?: boolean;
        __appReadyAt?: number;
        __logLevel?: unknown;
    }
}

export {};
