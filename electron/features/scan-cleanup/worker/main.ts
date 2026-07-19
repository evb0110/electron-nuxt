import {
    parentPort,
    workerData,
} from 'worker_threads';
import type { IScanCleanupProgress } from '@contracts/electronApiScanCleanup';
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
};
const abortController = new AbortController();
port.on('message', message => {
    if ((message as {type?: string}).type === 'cancel') abortController.abort(new DOMException('Scan cleanup canceled', 'AbortError'));
});
try {
    const result = await runScanCleanupPipeline(
        data.request,
        data.paths,
        abortController.signal,
        (progress: IScanCleanupProgress) => port.postMessage({
            type: 'progress',
            progress,
        }),
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
