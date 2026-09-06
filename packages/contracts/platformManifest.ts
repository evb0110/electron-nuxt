export type TPlatformBackend = 'electron' | 'browser';

export const PLATFORM_CONTRACT_VERSION = 1 as const;
export type TPlatformContractVersion = typeof PLATFORM_CONTRACT_VERSION;

export interface IPlatformCapabilityManifest {
    readonly documents: {
        readonly picker: boolean;
        readonly folderPicker: boolean;
        readonly nativePaths: boolean;
        readonly browserDocumentRefs: boolean;
        readonly nativePrint: boolean;
        readonly nativeOpenInDefaultApp: boolean;
        readonly recentFiles: boolean;
        readonly menuEvents: boolean;
        readonly structuredSaveResult: boolean;
    };
    readonly windowTabs: boolean;
    readonly agent: boolean;
    readonly updates: boolean;
}

export interface IPlatformRuntimeManifest {
    readonly backend: TPlatformBackend;
    readonly contractVersion: TPlatformContractVersion;
    readonly capabilities: IPlatformCapabilityManifest;
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
