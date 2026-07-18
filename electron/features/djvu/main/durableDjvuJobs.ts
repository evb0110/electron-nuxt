import type {
    IDjvuConvertResult,
    IDjvuOpenResult,
} from '@contracts/electronApiDjvu';
import type { IDjvuOperationContext } from '@electron/features/djvu/ports';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import { allowOpenPath } from '@electron/file-access/openPathCapabilities';
import { documentOutputService } from '@electron/output/documentOutputService';
import { adoptDjvuViewingPath } from '@electron/features/djvu/main/viewing';

const RETENTION_MS = 60 * 60 * 1_000;
const MAX_TERMINAL_JOBS = 64;
const convertJobs = new Map<string, Promise<IDjvuConvertResult>>();
const openJobs = new Map<string, {
    path: TOpenPath;
    promise: Promise<IDjvuOpenResult>;
}>();
interface ITerminalDjvuJob {
    kind: 'convert' | 'open';
    promise: Promise<IDjvuConvertResult> | Promise<IDjvuOpenResult>;
    timer: ReturnType<typeof setTimeout>;
}
const terminalJobs = new Map<string, ITerminalDjvuJob>();

function deleteTerminalJob(
    jobId: string,
    expectedPromise?: Promise<IDjvuConvertResult> | Promise<IDjvuOpenResult>,
) {
    const terminal = terminalJobs.get(jobId);
    if (!terminal || expectedPromise && terminal.promise !== expectedPromise) {
        return;
    }
    clearTimeout(terminal.timer);
    terminalJobs.delete(jobId);
    if (terminal.kind === 'convert' && convertJobs.get(jobId) === terminal.promise) {
        convertJobs.delete(jobId);
    }
    if (terminal.kind === 'open' && openJobs.get(jobId)?.promise === terminal.promise) {
        openJobs.delete(jobId);
    }
}

function retainTerminalJob(
    jobId: string,
    kind: ITerminalDjvuJob['kind'],
    promise: ITerminalDjvuJob['promise'],
) {
    deleteTerminalJob(jobId);
    const timer = setTimeout(() => deleteTerminalJob(jobId, promise), RETENTION_MS);
    timer.unref?.();
    terminalJobs.set(jobId, {
        kind,
        promise,
        timer,
    });
    while (terminalJobs.size > MAX_TERMINAL_JOBS) {
        const oldestJobId = terminalJobs.keys().next().value;
        if (!oldestJobId) {
            break;
        }
        deleteTerminalJob(oldestJobId);
    }
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
    const promise = Promise.resolve().then(run);
    convertJobs.set(jobId, promise);
    void promise.then(
        () => retainTerminalJob(jobId, 'convert', promise),
        () => retainTerminalJob(jobId, 'convert', promise),
    );
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
    void promise.then(
        () => retainTerminalJob(jobId, 'open', promise),
        () => retainTerminalJob(jobId, 'open', promise),
    );
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
    // The durable job already completed the native metadata probe. Awaiting
    // only adopts the proven source capability for this renderer; repeating
    // the probe here doubled every cold-open critical path.
    adoptDjvuViewingPath(context, job.path);
    return result;
}

export function cancelDurableDjvuJob(jobId: string, reason = 'DjVu operation canceled') {
    return documentOutputService.cancel(jobId, reason);
}

export function clearDurableDjvuJobsForTests() {
    for (const terminal of terminalJobs.values()) {
        clearTimeout(terminal.timer);
    }
    terminalJobs.clear();
    convertJobs.clear();
    openJobs.clear();
}
