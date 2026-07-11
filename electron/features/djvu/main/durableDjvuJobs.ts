import type {
    IDjvuConvertResult,
    IDjvuOpenResult,
} from '@contracts/electronApiDjvu';
import type { IDjvuOperationContext } from '@electron/features/djvu/ports';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import { allowOpenPath } from '@electron/file-access/openPathCapabilities';
import { documentOutputService } from '@electron/output/documentOutputService';
import { handleDjvuOpenForViewing } from '@electron/features/djvu/main/viewing';

const RETENTION_MS = 60 * 60 * 1_000;
const convertJobs = new Map<string, Promise<IDjvuConvertResult>>();
const openJobs = new Map<string, {
    path: TOpenPath;
    promise: Promise<IDjvuOpenResult>;
}>();

function retainUntilExpired<T>(store: Map<string, T>, jobId: string) {
    const timer = setTimeout(() => store.delete(jobId), RETENTION_MS);
    timer.unref?.();
}

export function startDurableDjvuConvertJob(
    jobId: string,
    run: () => Promise<IDjvuConvertResult>,
) {
    const existing = convertJobs.get(jobId);
    if (existing) {
        return;
    }
    documentOutputService.start({
        jobId,
        operation: 'djvu-convert',
        sourceKind: 'djvu',
        initialPhase: 'queued',
    });
    convertJobs.set(jobId, Promise.resolve().then(run));
    retainUntilExpired(convertJobs, jobId);
}

export async function awaitDurableDjvuConvertJob(context: IDjvuOperationContext, jobId: string) {
    const promise = convertJobs.get(jobId);
    if (!promise) {
        throw new Error(`Unknown or expired DjVu conversion job: ${jobId}`);
    }
    const result = await promise;
    if (result.success && result.pdfPath) {
        allowOpenPath(result.pdfPath, context.sender);
    }
    return result;
}

export function startDurableDjvuOpenJob(
    jobId: string,
    path: TOpenPath,
    run: (signal: AbortSignal) => Promise<IDjvuOpenResult>,
) {
    if (openJobs.has(jobId)) {
        return;
    }
    const outputJob = documentOutputService.start({
        jobId,
        operation: 'djvu-open',
        sourceKind: 'djvu',
        initialPhase: 'loading',
    });
    const promise = Promise.resolve().then(() => run(outputJob.signal)).then((result) => {
        const currentState = documentOutputService.getState(jobId);
        if (currentState?.status === 'canceled') {
            return {
                success: false,
                jobId,
                error: currentState.error ?? 'DjVu open canceled',
            };
        }
        if (result.success) {
            documentOutputService.update(jobId, {
                phase: 'loading',
                percent: 100,
            });
            documentOutputService.finish(jobId, 'completed');
        } else {
            documentOutputService.finish(jobId, 'failed', result.error);
        }
        return {
            ...result,
            jobId,
        };
    }, (error: unknown) => {
        const currentState = documentOutputService.getState(jobId);
        if (currentState?.status === 'canceled') {
            return {
                success: false,
                jobId,
                error: currentState.error ?? 'DjVu open canceled',
            };
        }
        const message = error instanceof Error ? error.message : String(error);
        documentOutputService.finish(jobId, 'failed', message);
        return {
            success: false,
            jobId,
            error: message,
        };
    });
    openJobs.set(jobId, {
        path,
        promise,
    });
    retainUntilExpired(openJobs, jobId);
}

export async function awaitDurableDjvuOpenJob(context: IDjvuOperationContext, jobId: string) {
    const job = openJobs.get(jobId);
    if (!job) {
        throw new Error(`Unknown or expired DjVu open job: ${jobId}`);
    }
    const result = await job.promise;
    if (!result.success) {
        return result;
    }
    if (documentOutputService.getState(jobId)?.status === 'canceled') {
        return {
            success: false,
            jobId,
            error: 'DjVu open canceled',
        };
    }
    // Re-adopt the source capability after renderer reload/navigation.
    const adopted = await handleDjvuOpenForViewing(context, job.path);
    return {
        ...adopted,
        jobId,
    };
}

export function cancelDurableDjvuJob(jobId: string, reason = 'DjVu operation canceled') {
    return documentOutputService.cancel(jobId, reason);
}
