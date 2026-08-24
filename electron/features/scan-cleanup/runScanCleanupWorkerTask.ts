import {dirname} from 'path';
import { fileURLToPath } from 'url';
import { isRecord } from '@contracts/runtimeGuards';
import type {
    TScanCleanupProgress,
    TScanCleanupSummary,
} from '@contracts/electronApiScanCleanup';
import {SCAN_CLEANUP_SUMMARY_SCHEMA} from '@contracts/scan-cleanup/ipc';
import {SCAN_CLEANUP_PROGRESS_SCHEMA} from '@contracts/scan-cleanup/progress';
import type { IScanCleanupRuntimePolicy } from '@contracts/resourcePolicies';
import type {
    IRunScanCleanupPipelineRequest,
    IScanCleanupWorkerPaths,
} from '@electron/features/scan-cleanup/worker/runScanCleanupPipeline';
import {
    hasWorkerTaskErrorBeenReported,
    resolveUnpackedWorkerPath,
    startStreamingWorkerTask,
} from '@electron/utils/workerTask';
import {isAbortError} from '@electron/utils/abort';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import {createLogger} from '@electron/utils/createLogger';

const currentDir = dirname(fileURLToPath(import.meta.url));
const workerFileName = WORKER_BUNDLES_BY_ID['scan-cleanup'].fileName;
const logger = createLogger('scan-cleanup-worker-task');

function decodeProgress(value: unknown): TScanCleanupProgress | null {
    if (!isRecord(value) || value.type !== 'progress') {
        return null;
    }
    try {
        return SCAN_CLEANUP_PROGRESS_SCHEMA.decode(value.progress);
    } catch (error) {
        logger.error(
            `Rejected scan cleanup worker progress: ${JSON.stringify(value)} `
            + `(${error instanceof Error ? error.message : String(error)})`,
        );
        return null;
    }
}

function decodeSummary(value: unknown): TScanCleanupSummary | null {
    try {
        return SCAN_CLEANUP_SUMMARY_SCHEMA.decode(value);
    } catch {
        return null;
    }
}

export async function runScanCleanupWorkerTask(
    request: IRunScanCleanupPipelineRequest,
    paths: IScanCleanupWorkerPaths,
    runtimePolicy: IScanCleanupRuntimePolicy,
    signal: AbortSignal,
    onProgress: (progress: TScanCleanupProgress) => void,
) {
    const task = startStreamingWorkerTask<TScanCleanupSummary>({
        workerPath: resolveUnpackedWorkerPath(currentDir, workerFileName),
        workerData: {
            request,
            paths,
            runtimePolicy,
        },
        invalidPayloadMessage: 'Scan cleanup worker returned an invalid payload',
        invalidResultMessage: 'Scan cleanup worker returned an invalid summary',
        createStartupError: message => new Error(`Scan cleanup worker startup failed: ${message}`),
        createWorkerExitError: code => new Error(`Scan cleanup worker exited with code ${code}`),
        // A high-DPI book can legitimately take longer than an hour while
        // still completing pages continuously. Guard against a stalled worker
        // without canceling healthy long-running cleanup jobs.
        inactivityTimeoutMs: 60 * 60 * 1000,
        resourceLimits: {
            maxOldGenerationSizeMb: 256,
            maxYoungGenerationSizeMb: 64,
            stackSizeMb: 4,
        },
        signal,
        // AbortSignal is the transport. This worker adapter translates abort to
        // a cooperative message and lets the worker-task harness force terminate
        // after the grace period. Generation counters are never used to cancel.
        createCancelMessage: () => ({type: 'cancel'}),
        cooperativeCancelDelayMs: 5_000,
        onProgressMessage: value => {
            const progress = decodeProgress(value);
            if (!progress) {
                return false;
            }
            onProgress(progress);
            return true;
        },
        decodeResult: decodeSummary,
    });
    try {
        return await task.promise;
    } catch (error) {
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
        if (signal.aborted || isAbortError(error)) {
            logger.info('Scan cleanup worker task canceled');
        } else if (hasWorkerTaskErrorBeenReported(error)) {
            // The generic worker-task layer already reported this exact
            // rejection at error level. Repeating it at error level would make
            // the renderer count one fault twice, so keep the scan-cleanup
            // context below the reporting threshold.
            logger.warn(`Scan cleanup worker task rejected (already reported): ${detail}`);
        } else {
            logger.error(`Scan cleanup worker task rejected: ${detail}`);
        }
        throw error;
    }
}
