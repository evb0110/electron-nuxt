import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type { IIpcMainRegistrar } from '@contracts/ipcMain';
import {
    SCAN_CLEANUP_CHANNELS,
    type IScanCleanupInvokeMap,
} from '@electron/features/scan-cleanup/contract';
import {
    createScanCleanupService,
    type IScanCleanupService,
} from '@electron/features/scan-cleanup/createScanCleanupService';
import {
    createScanCleanupPreviewService,
    type IScanCleanupPreviewService,
} from '@electron/features/scan-cleanup/createScanCleanupPreviewService';

export function registerScanCleanupIpcAdapter(
    registrar: IIpcMainRegistrar<IScanCleanupInvokeMap, IpcMainInvokeEvent> = ipcMain,
    service: IScanCleanupService = createScanCleanupService(),
    previewService: IScanCleanupPreviewService = createScanCleanupPreviewService(),
) {
    registrar.handle(SCAN_CLEANUP_CHANNELS.preview, (_event, request) => previewService.preview(request));
    registrar.handle(SCAN_CLEANUP_CHANNELS.cancelPreview, (_event, sourcePdfPath) => previewService.cancel(sourcePdfPath));
    registrar.handle(SCAN_CLEANUP_CHANNELS.start, (event, request) => service.start(event.sender, request));
    registrar.handle(SCAN_CLEANUP_CHANNELS.cancel, (_event, jobId) => service.cancel(jobId));
    registrar.handle(SCAN_CLEANUP_CHANNELS.getJobState, (_event, jobId) => service.getState(jobId));
    registrar.handle(SCAN_CLEANUP_CHANNELS.subscribeJob, (event, jobId) => service.subscribe(event.sender, jobId));
    registrar.handle(SCAN_CLEANUP_CHANNELS.reconnectJob, (event, jobId) => service.subscribe(event.sender, jobId));
    registrar.handle(SCAN_CLEANUP_CHANNELS.pruneGeneratedOutputs, (_event, openPdfPaths) => service.pruneGeneratedOutputs(openPdfPaths));
}
