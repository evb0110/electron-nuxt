import {dirname} from 'path';
import { fileURLToPath } from 'url';
import { isRecord } from '@contracts/runtimeGuards';
import type {
    IScanCleanupProgress,
    IScanCleanupSummary,
} from '@contracts/electronApiScanCleanup';
import type {
    IRunScanCleanupPipelineRequest,
    IScanCleanupWorkerPaths,
} from '@electron/features/scan-cleanup/worker/runScanCleanupPipeline';
import {
    resolveUnpackedWorkerPath,
    startStreamingWorkerTask,
} from '@electron/utils/workerTask';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const workerFileName = WORKER_BUNDLES_BY_ID['scan-cleanup'].fileName;

function decodeProgress(value: unknown): IScanCleanupProgress | null {
    if (
        !isRecord(value)
        || value.type !== 'progress'
        || !isRecord(value.progress)
        || ![
            'queued',
            'normalizing',
            'rasterizing',
            'cleaning',
            'assembling',
            'handoff',
        ].includes(String(value.progress.phase))
        || typeof value.progress.processedCount !== 'number'
        || typeof value.progress.totalPages !== 'number'
        || typeof value.progress.percent !== 'number'
    ) {
        return null;
    }
    return {
        phase: value.progress.phase as IScanCleanupProgress['phase'],
        processedCount: value.progress.processedCount,
        totalPages: value.progress.totalPages,
        percent: value.progress.percent,
    };
}

function decodeSummary(value: unknown): IScanCleanupSummary | null {
    if (
        !isRecord(value)
        || ![
            value.inputPages,
            value.outputPages,
            value.spreadsSplit,
            value.offcutsDiscarded,
            value.deskewSkipped,
            value.cropSkipped,
        ].every(item => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)
        || !Array.isArray(value.warnings)
        || value.warnings.some(item => typeof item !== 'string')
    ) {
        return null;
    }
    return {
        inputPages: value.inputPages as number,
        outputPages: value.outputPages as number,
        spreadsSplit: value.spreadsSplit as number,
        offcutsDiscarded: value.offcutsDiscarded as number,
        deskewSkipped: value.deskewSkipped as number,
        cropSkipped: value.cropSkipped as number,
        warnings: value.warnings.filter((item): item is string => typeof item === 'string'),
    };
}

export async function runScanCleanupWorkerTask(
    request: IRunScanCleanupPipelineRequest,
    paths: IScanCleanupWorkerPaths,
    signal: AbortSignal,
    onProgress: (progress: IScanCleanupProgress) => void,
) {
    const task = startStreamingWorkerTask<IScanCleanupSummary>({
        workerPath: resolveUnpackedWorkerPath(currentDir, workerFileName),
        workerData: {
            request,
            paths,
        },
        invalidPayloadMessage: 'Scan cleanup worker returned an invalid payload',
        invalidResultMessage: 'Scan cleanup worker returned an invalid summary',
        createStartupError: message => new Error(`Scan cleanup worker startup failed: ${message}`),
        createWorkerExitError: code => new Error(`Scan cleanup worker exited with code ${code}`),
        timeoutMs: 60 * 60 * 1000,
        resourceLimits: {
            maxOldGenerationSizeMb: 256,
            maxYoungGenerationSizeMb: 64,
            stackSizeMb: 4,
        },
        signal,
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
    return task.promise;
}
