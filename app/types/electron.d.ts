import type {
    IPlatformApi,
    TDocumentRef,
} from '@contracts/platform-api';

declare global {
    interface Window {
        electronAPI?: IPlatformApi;
        __openFileDirect?: (path: TDocumentRef) => Promise<void>;
        __handleSave?: () => Promise<void>;
        __appReady?: boolean;
        __logLevel?: unknown;
    }
}

export {};
