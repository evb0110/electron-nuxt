export type TPlatformBackend = 'electron' | 'browser';

export const PLATFORM_CONTRACT_VERSION = 1 as const;
export type TPlatformContractVersion = typeof PLATFORM_CONTRACT_VERSION;

export interface IPlatformCapabilityManifest {
    documents: {
        picker: boolean;
        folderPicker: boolean;
        nativePaths: boolean;
        browserDocumentRefs: boolean;
        nativePrint: boolean;
        nativeOpenInDefaultApp: boolean;
        recentFiles: boolean;
        menuEvents: boolean;
        structuredSaveResult: boolean;
    };
    windowTabs: boolean;
    agent: boolean;
    updates: boolean;
}

export interface IPlatformRuntimeManifest {
    backend: TPlatformBackend;
    contractVersion: TPlatformContractVersion;
    capabilities: IPlatformCapabilityManifest;
}

export const ELECTRON_PLATFORM_MANIFEST = {
    backend: 'electron',
    contractVersion: PLATFORM_CONTRACT_VERSION,
    capabilities: {
        documents: {
            picker: true,
            folderPicker: true,
            nativePaths: true,
            browserDocumentRefs: false,
            nativePrint: true,
            nativeOpenInDefaultApp: true,
            recentFiles: true,
            menuEvents: true,
            structuredSaveResult: true,
        },
        windowTabs: true,
        agent: true,
        updates: true,
    },
} as const satisfies IPlatformRuntimeManifest;

export const BROWSER_PLATFORM_MANIFEST = {
    backend: 'browser',
    contractVersion: PLATFORM_CONTRACT_VERSION,
    capabilities: {
        documents: {
            picker: true,
            folderPicker: false,
            nativePaths: false,
            browserDocumentRefs: true,
            nativePrint: false,
            nativeOpenInDefaultApp: false,
            recentFiles: true,
            menuEvents: false,
            structuredSaveResult: true,
        },
        windowTabs: true,
        agent: true,
        updates: false,
    },
} as const satisfies IPlatformRuntimeManifest;
