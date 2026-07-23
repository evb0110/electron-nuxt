import type { TPlatformBackend } from '@contracts/platformManifest';

export type TPlatformMethodKind = 'async' | 'event' | 'sync' | 'void';
export type TBrowserPlatformLazyMode = 'forwarded' | 'direct';

export interface IPlatformMethodDescriptor {
    path: readonly string[];
    kind: TPlatformMethodKind;
    required: Record<TPlatformBackend, boolean>;
    optionalWhenImplemented?: boolean;
    aliasOf?: readonly string[];
    browserLazy: TBrowserPlatformLazyMode;
}

export interface IPlatformCapabilityDescriptor {
    path: readonly string[];
    required: Record<TPlatformBackend, boolean>;
    manifestPath?: readonly string[];
}

export interface IPlatformApiDescriptor {
    capabilities: readonly IPlatformCapabilityDescriptor[];
    methods: readonly IPlatformMethodDescriptor[];
}
