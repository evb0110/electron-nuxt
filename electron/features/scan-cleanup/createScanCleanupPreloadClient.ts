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

export function createScanCleanupPreloadClient(
    ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener' | 'send'>,
): IScanCleanupCapability {
    const invoke = createCodecIpcInvoker<IScanCleanupInvokeMap>(ipcRenderer, SCAN_CLEANUP_IPC_CODECS);
    const events = createTypedIpcEventSubscriber<IScanCleanupEventMap>(ipcRenderer);
    return {
        previewRaw: request => invoke(SCAN_CLEANUP_CHANNELS.previewRaw, request),
        preview: request => invoke(SCAN_CLEANUP_CHANNELS.preview, request),
        cancelPreview: request => invoke(SCAN_CLEANUP_CHANNELS.cancelPreview, request),
        detectAll: request => invoke(SCAN_CLEANUP_CHANNELS.detectAll, request),
        cancelDetection: (jobId, ownerId) => invoke(SCAN_CLEANUP_CHANNELS.cancelDetection, jobId, ownerId),
        getDetectionJobState: (jobId, ownerId) => invoke(SCAN_CLEANUP_CHANNELS.getDetectionJobState, jobId, ownerId),
        subscribeDetectionJob: (jobId, ownerId) => invoke(SCAN_CLEANUP_CHANNELS.subscribeDetectionJob, jobId, ownerId),
        start: request => invoke(SCAN_CLEANUP_CHANNELS.start, request),
        cancel: (jobId, ownerId) => invoke(SCAN_CLEANUP_CHANNELS.cancel, jobId, ownerId),
        getJobState: (jobId, ownerId) => invoke(SCAN_CLEANUP_CHANNELS.getJobState, jobId, ownerId),
        subscribeJob: (jobId, ownerId) => invoke(SCAN_CLEANUP_CHANNELS.subscribeJob, jobId, ownerId),
        reconnectJob: (jobId, ownerId) => invoke(SCAN_CLEANUP_CHANNELS.reconnectJob, jobId, ownerId),
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
