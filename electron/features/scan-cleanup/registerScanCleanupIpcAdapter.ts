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
    registrar.handle(SCAN_CLEANUP_CHANNELS.previewRaw, (event, request) => previewService.previewRaw(event.sender, request));
    registrar.handle(SCAN_CLEANUP_CHANNELS.preview, (event, request) => previewService.preview(event.sender, request));
    registrar.handle(SCAN_CLEANUP_CHANNELS.cancelPreview, (event, request) => previewService.cancel(event.sender, request));
    registrar.handle(SCAN_CLEANUP_CHANNELS.detectAll, (event, request) => previewService.detectAll(event.sender, request));
    registrar.handle(SCAN_CLEANUP_CHANNELS.cancelDetection, (event, jobId, ownerId) => previewService.cancelDetection(event.sender, jobId, ownerId));
    registrar.handle(SCAN_CLEANUP_CHANNELS.getDetectionJobState, (event, jobId, ownerId) => previewService.getDetectionJobState(event.sender, jobId, ownerId));
    registrar.handle(SCAN_CLEANUP_CHANNELS.subscribeDetectionJob, (event, jobId, ownerId) => previewService.subscribeDetectionJob(event.sender, jobId, ownerId));
    registrar.handle(SCAN_CLEANUP_CHANNELS.start, (event, request) => service.start(event.sender, request));
    registrar.handle(SCAN_CLEANUP_CHANNELS.cancel, (event, jobId, ownerId) => service.cancel(event.sender, jobId, ownerId));
    registrar.handle(SCAN_CLEANUP_CHANNELS.getJobState, (event, jobId, ownerId) => service.getState(event.sender, jobId, ownerId));
    registrar.handle(SCAN_CLEANUP_CHANNELS.subscribeJob, (event, jobId, ownerId) => service.subscribe(event.sender, jobId, ownerId));
    registrar.handle(SCAN_CLEANUP_CHANNELS.reconnectJob, (event, jobId, ownerId) => service.subscribe(event.sender, jobId, ownerId));
    registrar.handle(SCAN_CLEANUP_CHANNELS.pruneGeneratedOutputs, (_event, openPdfPaths) => service.pruneGeneratedOutputs(openPdfPaths));
}
