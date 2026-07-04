import type {
    IOcrActiveJob,
    IOcrPreparingJob,
    IOcrQueuedJob,
} from '@electron/ocr/jobManager.types';
import { normalizePathForLookup } from '@electron/file-access/workingCopyStore';

interface IOcrWorkingCopyInvalidationLogger { info(message: string): void; }

interface IOcrWorkingCopyInvalidationControllerOptions {
    abortPreparingJob: (scopedJobId: string, reason: string) => boolean;
    activeJobs: Map<string, IOcrActiveJob>;
    logger: IOcrWorkingCopyInvalidationLogger;
    queuedJobs: IOcrQueuedJob[];
    removeQueuedJob: (scopedJobId: string, nextState: 'cancelling' | 'finalized') => IOcrQueuedJob | null;
    sendJobCancellation: (
        job: Pick<IOcrQueuedJob | IOcrPreparingJob, 'scopedJobId' | 'requestId' | 'webContentsId'>,
        reason: string,
    ) => void;
    terminateAndFinalizeActiveJob: (
        scopedJobId: string,
        options: {
            markCancelled?: boolean;
            reason: string;
        },
    ) => void;
    preparingJobs: Map<string, IOcrPreparingJob>;
}

function getOcrSourcePathKey(sourcePdfPath: string) {
    return normalizePathForLookup(sourcePdfPath) || sourcePdfPath;
}

export function createOcrWorkingCopyInvalidationController(options: IOcrWorkingCopyInvalidationControllerOptions) {
    function cancelOcrJobsForWorkingCopy(workingCopyPath: string, reason: string) {
        const targetPathKey = getOcrSourcePathKey(workingCopyPath);
        let canceledCount = 0;

        for (const preparingJob of Array.from(options.preparingJobs.values())) {
            if (getOcrSourcePathKey(preparingJob.sourcePdfPath) !== targetPathKey) {
                continue;
            }

            if (options.abortPreparingJob(preparingJob.scopedJobId, reason)) {
                canceledCount += 1;
                options.sendJobCancellation(preparingJob, reason);
                options.logger.info(`[${preparingJob.requestId}] Cancelled preparing OCR job for stale working copy: ${reason}`);
            }
        }

        const queuedForWorkingCopy = options.queuedJobs
            .filter(job => getOcrSourcePathKey(job.sourcePdfPath) === targetPathKey)
            .map(job => job.scopedJobId);
        for (const scopedJobId of queuedForWorkingCopy) {
            const removedJob = options.removeQueuedJob(scopedJobId, 'cancelling');
            if (removedJob) {
                canceledCount += 1;
                options.sendJobCancellation(removedJob, reason);
                options.logger.info(`[${removedJob.requestId}] Removed queued OCR job for stale working copy: ${reason}`);
            }
        }

        const activeForWorkingCopy = Array.from(options.activeJobs.values())
            .filter(activeJob => getOcrSourcePathKey(activeJob.sourcePdfPath) === targetPathKey);
        for (const activeJob of activeForWorkingCopy) {
            options.terminateAndFinalizeActiveJob(activeJob.scopedJobId, {
                markCancelled: true,
                reason,
            });
            canceledCount += 1;
            options.logger.info(`[${activeJob.requestId}] Cancelled active OCR job for stale working copy: ${reason}`);
        }

        return canceledCount;
    }

    return { cancelOcrJobsForWorkingCopy };
}
