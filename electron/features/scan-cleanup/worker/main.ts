import {
    parentPort,
    workerData,
} from 'worker_threads';
import type {TScanCleanupProgress} from '@contracts/electronApiScanCleanup';
import { decodeScanCleanupRuntimePolicy } from '@contracts/resourcePolicies';
import { createLogger } from '@electron/utils/createLogger';
import { createWorkerTaskErrorFrame } from '@electron/utils/workerTask';
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
port.on('message', message => {
    if ((message as {type?: string}).type === 'cancel') abortController.abort(new DOMException('Scan cleanup canceled', 'AbortError'));
});
try {
    const runtimePolicy = decodeScanCleanupRuntimePolicy(data.runtimePolicy);
    if (!runtimePolicy) throw new Error('Scan cleanup worker received an invalid runtime policy');
    const result = await runScanCleanupPipeline(
        data.request,
        data.paths,
        abortController.signal,
        (progress: TScanCleanupProgress) => port.postMessage({
            type: 'progress',
            progress,
        }),
        runtimePolicy,
        (level, message) => logger[level](message),
    );
    port.postMessage({
        type: 'result',
        ok: true,
        data: result,
    });
} catch (error) {
    port.postMessage({
        type: 'result',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorFrame: createWorkerTaskErrorFrame(error, {source: 'scan-cleanup'}),
    });
}
