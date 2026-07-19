import type { IpcRenderer } from 'electron';
import type { IScanCleanupCapability } from '@contracts/electronApiScanCleanup';
import {
    SCAN_CLEANUP_CHANNELS,
    SCAN_CLEANUP_EVENT_CHANNELS,
    type IScanCleanupEventMap,
    type IScanCleanupInvokeMap,
} from '@electron/features/scan-cleanup/contract';
import {
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
        cancelPreview: sourcePdfPath => invoke(SCAN_CLEANUP_CHANNELS.cancelPreview, sourcePdfPath),
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
    };
}
