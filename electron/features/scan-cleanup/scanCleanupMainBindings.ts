import type {IpcMainInvokeEvent} from 'electron';
import type {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scanCleanupPlatformFeature';
import type {TFeatureMainBindings} from '@contracts/platformFeature';
import {createScanCleanupPreviewService} from '@electron/features/scan-cleanup/createScanCleanupPreviewService';
import {createScanCleanupService} from '@electron/features/scan-cleanup/createScanCleanupService';

const previewService = createScanCleanupPreviewService();
const service = createScanCleanupService();

export const scanCleanupMainBindings = {
    previewRaw: (context, request) => previewService.previewRaw(context.sender, request),
    preview: (context, request) => previewService.preview(context.sender, request),
    cancelPreview: (context, request) => previewService.cancel(context.sender, request),
    detectAll: (context, request) => previewService.detectAll(context.sender, request),
    cancelDetection: (context, jobId, owner) =>
        previewService.cancelDetection(context.sender, jobId, owner),
    getDetectionJobState: (context, jobId, owner) =>
        previewService.getDetectionJobState(context.sender, jobId, owner),
    subscribeDetectionJob: (context, jobId, owner) =>
        previewService.subscribeDetectionJob(context.sender, jobId, owner),
    start: (context, request) => service.start(context.sender, request),
    cancel: (context, jobId, owner) => service.cancel(context.sender, jobId, owner),
    getJobState: (context, jobId, owner) => service.getState(context.sender, jobId, owner),
    subscribeJob: (context, jobId, owner) => service.subscribe(context.sender, jobId, owner),
    reconnectJob: (context, jobId, owner) => service.subscribe(context.sender, jobId, owner),
    pruneGeneratedOutputs: openPdfPaths => service.pruneGeneratedOutputs(openPdfPaths),
} satisfies TFeatureMainBindings<typeof SCAN_CLEANUP_PLATFORM_FEATURE, IpcMainInvokeEvent>;
