import type { IOcrPreparingJob } from '@electron/ocr/jobManager.types';
import type { IOcrJobOperationContext } from '@electron/ocr/ocrJobOperationContext';

export function createPreparingOcrJob(
    context: IOcrJobOperationContext,
    scopedJobId: string,
    requestId: string,
    sourcePdfPath: string,
    documentRevision: IOcrPreparingJob['documentRevision'],
): IOcrPreparingJob {
    return {
        lifecycleState: 'preparing',
        scopedJobId,
        requestId,
        webContentsId: context.senderId,
        sourcePdfPath,
        documentRevision,
        requestedBytes: 0,
        startedAtMs: Date.now(),
        abortController: new AbortController(),
    };
}
