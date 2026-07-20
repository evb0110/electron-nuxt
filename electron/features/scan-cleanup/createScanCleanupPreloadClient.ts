import type { IpcRenderer } from 'electron';
import type { IScanCleanupCapability } from '@contracts/electronApiScanCleanup';
import {
    SCAN_CLEANUP_CHANNELS,
    SCAN_CLEANUP_EVENT_CHANNELS,
    type IScanCleanupEventMap,
    type IScanCleanupInvokeMap,
} from '@electron/features/scan-cleanup/contract';
import {
    decodeScanCleanupDetectionJobState,
    decodeScanCleanupJobState,
    SCAN_CLEANUP_IPC_CODECS,
} from '@electron/features/scan-cleanup/scanCleanupIpcCodecs';
import {
    createCodecIpcInvoker,
    createTypedIpcEventSubscriber,
} from '@electron/preload/ipcClient';

export function createScanCleanupPreloadClient(ipcRenderer: IpcRenderer): IScanCleanupCapability {
    const invoke = createCodecIpcInvoker<IScanCleanupInvokeMap>(ipcRenderer, SCAN_CLEANUP_IPC_CODECS);
    const events = createTypedIpcEventSubscriber<IScanCleanupEventMap>(ipcRenderer);
    return {
        preview: request => invoke(SCAN_CLEANUP_CHANNELS.preview, request),
        cancelPreview: (sourcePdfPath, invalidateRawCache) => invalidateRawCache === undefined
            ? invoke(SCAN_CLEANUP_CHANNELS.cancelPreview, sourcePdfPath)
            : invoke(SCAN_CLEANUP_CHANNELS.cancelPreview, sourcePdfPath, invalidateRawCache),
        detectAll: request => invoke(SCAN_CLEANUP_CHANNELS.detectAll, request),
        cancelDetection: jobId => invoke(SCAN_CLEANUP_CHANNELS.cancelDetection, jobId),
        getDetectionJobState: jobId => invoke(SCAN_CLEANUP_CHANNELS.getDetectionJobState, jobId),
        subscribeDetectionJob: jobId => invoke(SCAN_CLEANUP_CHANNELS.subscribeDetectionJob, jobId),
        start: request => invoke(SCAN_CLEANUP_CHANNELS.start, request),
        cancel: jobId => invoke(SCAN_CLEANUP_CHANNELS.cancel, jobId),
        getJobState: jobId => invoke(SCAN_CLEANUP_CHANNELS.getJobState, jobId),
        subscribeJob: jobId => invoke(SCAN_CLEANUP_CHANNELS.subscribeJob, jobId),
        reconnectJob: jobId => invoke(SCAN_CLEANUP_CHANNELS.reconnectJob, jobId),
        pruneGeneratedOutputs: openPdfPaths => invoke(SCAN_CLEANUP_CHANNELS.pruneGeneratedOutputs, openPdfPaths),
        onJobState: callback => events.onDecodedPayload(
            SCAN_CLEANUP_EVENT_CHANNELS.state,
            value => {
                try {
                    return decodeScanCleanupJobState(value);
                } catch {
                    return null;
                }
            },
            callback,
        ),
        onDetectionJobState: callback => events.onDecodedPayload(
            SCAN_CLEANUP_EVENT_CHANNELS.detectionState,
            value => {
                try {
                    return decodeScanCleanupDetectionJobState(value);
                } catch {
                    return null;
                }
            },
            callback,
        ),
    };
}
