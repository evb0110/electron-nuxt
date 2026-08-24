import {
    parentPort,
    workerData,
} from 'worker_threads';
import {basename} from 'path';
import type {TScanCleanupProgress} from '@contracts/electronApiScanCleanup';
import { decodeScanCleanupRuntimePolicy } from '@contracts/resourcePolicies';
import { createLogger } from '@electron/utils/createLogger';
import { createWorkerTaskErrorFrame } from '@electron/utils/workerTask';
import { isAbortError } from '@electron/utils/abort';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';
import {
    runScanCleanupPipeline,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupWorkerPaths,
} from '@electron/features/scan-cleanup/worker/runScanCleanupPipeline';

if (!parentPort) throw new Error('Scan cleanup worker started without a parent port');
const port = parentPort;
const data = workerData as {
    request: IRunScanCleanupPipelineRequest;
    paths: IScanCleanupWorkerPaths;
    runtimePolicy?: unknown;
};
const logger = createLogger('scan-cleanup-worker');
const abortController = new AbortController();
const startedAt = performance.now();
let lastProgressStage: TScanCleanupProgress['stage'] | null = null;
port.on('message', message => {
    if ((message as {type?: string}).type === 'cancel') abortController.abort(new DOMException('Scan cleanup canceled', 'AbortError'));
});
try {
    const runtimePolicy = decodeScanCleanupRuntimePolicy(data.runtimePolicy);
    if (!runtimePolicy) throw new Error('Scan cleanup worker received an invalid runtime policy');
    logger.info(
        `Run started: source=${basename(data.request.sourcePdfPath)} `
        + `selectedPages=${String(data.request.sourcePageNumbers?.length ?? 'all')}`,
    );
    const result = await runScanCleanupPipeline(
        data.request,
        data.paths,
        abortController.signal,
        (progress: TScanCleanupProgress) => {
            if (progress.stage !== lastProgressStage) {
                lastProgressStage = progress.stage;
                logger.info(
                    `Phase started: stage=${progress.stage} `
                    + `completed=${String(progress.completedUnits)}/${String(progress.totalUnits)} `
                    + `percent=${progress.percent.toFixed(1)} `
                    + `completedPageNumbers=${JSON.stringify(progress.completedPageNumbers ?? null)}`,
                );
            }
            port.postMessage({
                type: 'progress',
                progress,
            });
        },
        runtimePolicy,
        (level, message) => logger[level](message),
    );
    port.postMessage({
        type: 'result',
        ok: true,
        data: result,
    });
    logger.info(
        `Run completed: inputPages=${String(result.inputPages)} `
        + `outputPages=${String(result.outputPages)} `
        + `durationMs=${String(Math.round(performance.now() - startedAt))}`,
    );
} catch (error) {
    const elapsedMs = String(Math.round(performance.now() - startedAt));
    // A cancelled run ends by throwing the abort reason. That is the requested
    // outcome, so it is reported as the end of the run and not as a failure.
    const unprovenTermination = getUnprovenNativeTerminationDetail(error);
    if (unprovenTermination !== undefined) {
        // Main quarantines the source working copy on this. It is a contained
        // outcome rather than an application fault, so it stays at warn.
        logger.warn(`Run stopped after ${elapsedMs} ms without proving its native tree died: ${unprovenTermination}`);
    } else if (abortController.signal.aborted || isAbortError(error)) {
        logger.info(`Run canceled after ${elapsedMs} ms`);
    } else {
        logger.error(
            `Run failed after ${elapsedMs} ms: `
            + (error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)),
        );
    }
    port.postMessage({
        type: 'result',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorFrame: createWorkerTaskErrorFrame(error, {source: 'scan-cleanup'}),
    });
}
