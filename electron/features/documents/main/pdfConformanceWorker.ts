import {
    parentPort,
    workerData,
} from 'worker_threads';
import { analyzePdfConformanceFileDirect } from '@electron/features/documents/main/analyzePdfConformanceFileDirect';
import type { IWorkerTaskErrorFrame } from '@electron/utils/workerTask';
import { createWorkerTaskErrorFrame } from '@electron/utils/workerTask';
import { getErrorMessage } from '@electron/utils/error';
import { isRecord } from '@contracts/runtimeGuards';

interface IPdfConformanceWorkerData {
    filePath?: unknown;
    cancelGroup?: unknown;
    markerEvidence?: unknown;
}

type TPdfConformanceWorkerResult =
    | {
        type: 'result';
        ok: true;
        data: unknown;
    }
    | {
        type: 'result';
        ok: false;
        error: string;
        errorFrame?: IWorkerTaskErrorFrame;
    };

function resolveWorkerFilePath() {
    const currentWorkerData = workerData as IPdfConformanceWorkerData | undefined;
    if (typeof currentWorkerData?.filePath !== 'string' || currentWorkerData.filePath.trim().length === 0) {
        throw new Error('Invalid PDF conformance worker payload');
    }

    return currentWorkerData.filePath.trim();
}

async function runPdfConformanceWorker() {
    if (!parentPort) {
        throw new Error('PDF conformance worker started without a parentPort');
    }

    const abortController = new AbortController();
    const handleMessage = (message: unknown) => {
        if (isRecord(message) && message.type === 'cancel') {
            abortController.abort();
        }
    };
    parentPort.on('message', handleMessage);

    try {
        const currentWorkerData = workerData as IPdfConformanceWorkerData | undefined;
        const filePath = resolveWorkerFilePath();
        const cancelGroup = typeof currentWorkerData?.cancelGroup === 'string'
            && currentWorkerData.cancelGroup.trim().length > 0
            ? currentWorkerData.cancelGroup.trim()
            : undefined;
        const markerEvidence = currentWorkerData?.markerEvidence === 'structural-only'
            ? 'structural-only'
            : 'full';
        const data = await analyzePdfConformanceFileDirect(filePath, {
            signal: abortController.signal,
            ...(cancelGroup === undefined ? {} : {cancelGroup}),
            markerEvidence,
        });
        const payload: TPdfConformanceWorkerResult = {
            type: 'result',
            ok: true,
            data,
        };
        parentPort.postMessage(payload);
    } catch (error) {
        const payload: TPdfConformanceWorkerResult = {
            type: 'result',
            ok: false,
            error: getErrorMessage(error),
            errorFrame: createWorkerTaskErrorFrame(error, {source: 'documents:pdf-conformance-worker'}),
        };
        parentPort.postMessage(payload);
    } finally {
        parentPort.off('message', handleMessage);
        parentPort.close();
    }
}

await runPdfConformanceWorker();
