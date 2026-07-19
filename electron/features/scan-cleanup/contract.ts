import type {
    IScanCleanupCapability,
    IScanCleanupPreviewRequest,
    IScanCleanupStartRequest,
    TScanCleanupJobState,
} from '@contracts/electronApiScanCleanup';

export const SCAN_CLEANUP_CHANNELS = {
    preview: 'scan-cleanup:preview',
    cancelPreview: 'scan-cleanup:preview:cancel',
    start: 'scan-cleanup:start',
    cancel: 'scan-cleanup:cancel',
    getJobState: 'scan-cleanup:job:get-state',
    subscribeJob: 'scan-cleanup:job:subscribe',
    reconnectJob: 'scan-cleanup:job:reconnect',
    pruneGeneratedOutputs: 'scan-cleanup:output:prune',
} as const;

export const SCAN_CLEANUP_EVENT_CHANNELS = {state: 'scan-cleanup:job:state'} as const;

export interface IScanCleanupInvokeMap {
    [SCAN_CLEANUP_CHANNELS.preview]: {
        args: [request: IScanCleanupPreviewRequest];
        result: Awaited<ReturnType<IScanCleanupCapability['preview']>>;
    };
    [SCAN_CLEANUP_CHANNELS.cancelPreview]: {
        args: [sourcePdfPath: string];
        result: boolean;
    };
    [SCAN_CLEANUP_CHANNELS.start]: {
        args: [request: IScanCleanupStartRequest];
        result: Awaited<ReturnType<IScanCleanupCapability['start']>>;
    };
    [SCAN_CLEANUP_CHANNELS.cancel]: {
        args: [jobId: string];
        result: boolean;
    };
    [SCAN_CLEANUP_CHANNELS.getJobState]: {
        args: [jobId: string];
        result: TScanCleanupJobState | null;
    };
    [SCAN_CLEANUP_CHANNELS.subscribeJob]: {
        args: [jobId: string];
        result: TScanCleanupJobState | null;
    };
    [SCAN_CLEANUP_CHANNELS.reconnectJob]: {
        args: [jobId: string];
        result: TScanCleanupJobState | null;
    };
    [SCAN_CLEANUP_CHANNELS.pruneGeneratedOutputs]: {
        args: [openPdfPaths: string[]];
        result: number;
    };
}

export interface IScanCleanupEventMap {[SCAN_CLEANUP_EVENT_CHANNELS.state]: TScanCleanupJobState;}
