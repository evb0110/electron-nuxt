import {
    definePlatformFeature,
    runtimeSchema as s,
    type TFeatureCapability,
} from '@contracts/platformFeature';

export interface ISystemMemoryInfo {
    availableBytes: number;
    totalBytes: number;
    freeBytes: number;
}

const memoryInfo = s.trustedDirect<ISystemMemoryInfo | null>(() => null);

export const SYSTEM_PLATFORM_FEATURE = definePlatformFeature({
    path: ['system'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {getMemoryInfo: {
        kind: 'sync',
        result: memoryInfo,
        browser: {method: 'getMemoryInfo'},
        lazy: 'direct',
    }},
    events: {},
});

export interface IShutdownSaveFlushResponse {
    dirtyWorkingCopyPaths?: string[];
    flushedWorkingCopyPaths?: string[];
}

interface ISystemLifecycleCapability {onShutdownSaveFlushRequest: (
    callback: () => Promise<IShutdownSaveFlushResponse> | IShutdownSaveFlushResponse,
) => () => void;}

export type ISystemCapability = TFeatureCapability<typeof SYSTEM_PLATFORM_FEATURE> & ISystemLifecycleCapability;
