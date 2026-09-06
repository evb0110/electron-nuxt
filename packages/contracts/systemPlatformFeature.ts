import {
    definePlatformFeature,
    runtimeSchema as s,
    type TFeatureCapability,
} from '@contracts/platformFeature';
import type {TRequestId} from '@contracts/shared';

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
        args: s.tuple([]),
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

export type TWindowCloseDecision = 'save' | 'discard' | 'cancel';

export type TWindowCloseUnavailableReason =
    | 'no-handler'
    | 'multiple-handlers'
    | 'handler-error'
    | 'invalid-decision';

export interface IWindowCloseRequest {requestId: TRequestId;}

export type IWindowCloseResponse = {
    decision: TWindowCloseDecision;
    requestId: TRequestId;
} | {
    requestId: TRequestId;
    status: 'unavailable';
    reason: TWindowCloseUnavailableReason;
};

export type TWindowCloseRequestHandler = (
    request: IWindowCloseRequest,
) => Promise<TWindowCloseDecision> | TWindowCloseDecision;

interface ISystemLifecycleCapability {
    onShutdownSaveFlushRequest: (
        callback: () => Promise<IShutdownSaveFlushResponse> | IShutdownSaveFlushResponse,
    ) => () => void;
    onWindowCloseRequest?: (callback: TWindowCloseRequestHandler) => () => void;
}

export type ISystemCapability = TFeatureCapability<typeof SYSTEM_PLATFORM_FEATURE> & ISystemLifecycleCapability;
