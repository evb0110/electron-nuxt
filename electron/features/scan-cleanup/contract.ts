import type {
    IScanCleanupCapability,
    IScanCleanupDetectionRequest,
    IScanCleanupOwnerContext,
    IScanCleanupPreviewCancelRequest,
    IScanCleanupRawPreviewRequest,
    IScanCleanupPreviewRequest,
    IScanCleanupStartRequest,
    TScanCleanupJobState,
    TScanCleanupDetectionJobState,
} from '@contracts/electronApiScanCleanup';

export const SCAN_CLEANUP_CHANNELS = {
    previewRaw: 'scan-cleanup:preview:raw',
    preview: 'scan-cleanup:preview',
    cancelPreview: 'scan-cleanup:preview:cancel',
    detectAll: 'scan-cleanup:detect-all',
    cancelDetection: 'scan-cleanup:detect-all:cancel',
    getDetectionJobState: 'scan-cleanup:detect-all:get-state',
    subscribeDetectionJob: 'scan-cleanup:detect-all:subscribe',
    start: 'scan-cleanup:start',
    cancel: 'scan-cleanup:cancel',
    getJobState: 'scan-cleanup:job:get-state',
    subscribeJob: 'scan-cleanup:job:subscribe',
    reconnectJob: 'scan-cleanup:job:reconnect',
    pruneGeneratedOutputs: 'scan-cleanup:output:prune',
} as const;

export const SCAN_CLEANUP_EVENT_CHANNELS = {
    state: 'scan-cleanup:job:state',
    detectionState: 'scan-cleanup:detect-all:state',
} as const;

export interface IScanCleanupInvokeMap {
    [SCAN_CLEANUP_CHANNELS.previewRaw]: {
        args: [request: IScanCleanupRawPreviewRequest];
        result: Awaited<ReturnType<IScanCleanupCapability['previewRaw']>>;
    };
    [SCAN_CLEANUP_CHANNELS.preview]: {
        args: [request: IScanCleanupPreviewRequest];
        result: Awaited<ReturnType<IScanCleanupCapability['preview']>>;
    };
    [SCAN_CLEANUP_CHANNELS.cancelPreview]: {
        args: [request: IScanCleanupPreviewCancelRequest];
        result: boolean;
    };
    [SCAN_CLEANUP_CHANNELS.detectAll]: {
        args: [request: IScanCleanupDetectionRequest];
        result: Awaited<ReturnType<IScanCleanupCapability['detectAll']>>;
    };
    [SCAN_CLEANUP_CHANNELS.cancelDetection]: {
        args: [jobId: string, owner: IScanCleanupOwnerContext];
        result: boolean;
    };
    [SCAN_CLEANUP_CHANNELS.getDetectionJobState]: {
        args: [jobId: string, owner: IScanCleanupOwnerContext];
        result: TScanCleanupDetectionJobState | null;
    };
    [SCAN_CLEANUP_CHANNELS.subscribeDetectionJob]: {
        args: [jobId: string, owner: IScanCleanupOwnerContext];
        result: TScanCleanupDetectionJobState | null;
    };
    [SCAN_CLEANUP_CHANNELS.start]: {
        args: [request: IScanCleanupStartRequest];
        result: Awaited<ReturnType<IScanCleanupCapability['start']>>;
    };
    [SCAN_CLEANUP_CHANNELS.cancel]: {
        args: [jobId: string, owner: IScanCleanupOwnerContext];
        result: boolean;
    };
    [SCAN_CLEANUP_CHANNELS.getJobState]: {
        args: [jobId: string, owner: IScanCleanupOwnerContext];
        result: TScanCleanupJobState | null;
    };
    [SCAN_CLEANUP_CHANNELS.subscribeJob]: {
        args: [jobId: string, owner: IScanCleanupOwnerContext];
        result: TScanCleanupJobState | null;
    };
    [SCAN_CLEANUP_CHANNELS.reconnectJob]: {
        args: [jobId: string, owner: IScanCleanupOwnerContext];
        result: TScanCleanupJobState | null;
    };
    [SCAN_CLEANUP_CHANNELS.pruneGeneratedOutputs]: {
        args: [openPdfPaths: string[]];
        result: number;
    };
}

export interface IScanCleanupEventMap {
    [SCAN_CLEANUP_EVENT_CHANNELS.state]: TScanCleanupJobState;
    [SCAN_CLEANUP_EVENT_CHANNELS.detectionState]: TScanCleanupDetectionJobState;
}
